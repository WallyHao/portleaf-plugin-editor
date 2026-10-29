import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  protocol,
  shell,
  dialog,
  type IpcMainInvokeEvent,
} from 'electron';
import { stat, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDataService, type DataService, type WorkspaceRemote } from './data-service.js';
import type { AutomergeUrl, UrlHeads } from '@automerge/automerge-repo';
import { watch } from 'chokidar';
import { settings, selectTheme, appearanceFile, configRoot } from './settings.js';
import type { FileBrowseOptions, RecoveryDocument } from '@portleaf/core';
import { resourceResponse } from './resource-response.js';
import { within, RequestTimeout } from './requests.js';
import { recoveryDocuments, writeRecovery } from './recovery.js';

let window: BrowserWindow;
let workspace: WorkspaceRemote;
let workspaceRoot: string;
let dataService: DataService;
let workspaceReady: Promise<void>;
let initialFile: string | undefined;
let exiting = false;
let serviceClosing = false;
let serviceFailed = false;
let shutdownTask: Promise<boolean> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
const stateRoot =
  process.env.PORTLEAF_STATE_HOME ||
  path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
    'portleaf',
    'workspaces',
  );
app.setPath('userData', path.join(configRoot, 'runtime'));
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'portleaf-resource',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function authorized(event: IpcMainInvokeEvent) {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('Invalid IPC sender.');
}
function dataRequest<T>(operation: Promise<T>, label = 'Data service', timeout = 15_000) {
  return within(Promise.race([operation, dataService.failure]), timeout, label).catch((error) => {
    if (error instanceof RequestTimeout && !serviceClosing && !exiting) {
      serviceFailed = true;
      if (!window.isDestroyed())
        window.webContents.send('event', { type: 'data-unavailable', message: error.message });
    }
    throw error;
  });
}
function handle(channel: string, fn: (...args: any[]) => unknown, requiresData = true) {
  ipcMain.handle(channel, async (event, ...args) => {
    authorized(event);
    if (requiresData) {
      if (serviceFailed) throw new Error('Saving is unavailable. Save a recovery copy or restart.');
      await within(workspaceReady, 15_000, 'Workspace initialization');
    }
    const result = Promise.resolve(fn(...args));
    return requiresData ? dataRequest(result) : result;
  });
}
async function loadWorkspace(root: string) {
  serviceClosing = false;
  serviceFailed = false;
  workspaceRoot = root;
  dataService = createDataService();
  workspace = dataService.api;
  workspaceRoot = await dataService.init(root, stateRoot, (event) => {
    if (event.type === 'unavailable') serviceFailed = true;
    if (!window.isDestroyed())
      window.webContents.send(
        'event',
        event.type === 'unavailable' ? { ...event, type: 'data-unavailable' } : event,
      );
  });
  void dataService.failure.catch((error) => {
    serviceFailed = true;
    if (!window.isDestroyed() && !serviceClosing && !exiting)
      window.webContents.send('event', { type: 'data-unavailable', message: error.message });
  });
}

async function preserveRecovery(documents: RecoveryDocument[]) {
  let cached: RecoveryDocument[] = [];
  try {
    cached = await dataRequest(workspace.recoverySnapshot(), 'Recovery snapshot', 5000);
  } catch {
    /* The renderer copy remains available if its data worker has died. */
  }
  return writeRecovery(stateRoot, workspaceRoot, [...cached, ...documents]);
}

async function finishQuit() {
  serviceClosing = true;
  try {
    await dataService.dispose();
  } catch (error) {
    console.error('Worker cleanup failed after saving:', error);
    exiting = true;
    app.exit(0);
    return;
  }
  exiting = true;
  app.quit();
}

function requestQuit(documents: RecoveryDocument[] = []): Promise<boolean> {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  if (shutdownTask) return shutdownTask;
  shutdownTask = (async () => {
    while (true) {
      try {
        await within(workspaceReady, 15_000, 'Workspace initialization');
        for (const doc of documents)
          if (doc.url && doc.heads)
            await dataRequest(workspace.awaitHeads(doc.url as AutomergeUrl, doc.heads as UrlHeads));
        await dataRequest(workspace.close(), 'Save and close', 30_000);
        await finishQuit();
        return true;
      } catch (error) {
        try {
          await dataRequest(workspace.checkpoint(), 'Local history persistence', 5000);
        } catch {
          /* Offer an independent recovery file even when local storage failed. */
        }
        const choice = await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'Changes need recovery',
          message: 'Some changes could not be saved to their original files.',
          detail: `${String(error)}\n\nYou can retry, or save all available text versions in a separate recovery file before quitting. Original files will not be overwritten.`,
          buttons: ['Retry', 'Save recovery copy and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (choice.response === 2) return false;
        if (choice.response === 0) continue;
        const file = await preserveRecovery(documents);
        await dialog.showMessageBox(window, {
          type: 'info',
          title: 'Recovery copy saved',
          message: 'Your recovery copy was saved.',
          detail: file,
          buttons: ['Quit'],
          noLink: true,
        });
        try {
          await dataRequest(workspace.close({ project: false }), 'Close local history', 5000);
        } catch {
          /* Recovery has been written durably before the worker is terminated. */
        }
        await finishQuit();
        return true;
      }
    }
  })().finally(() => {
    shutdownTask = undefined;
  });
  return shutdownTask;
}

async function restart(documents: RecoveryDocument[]) {
  await preserveRecovery(documents);
  try {
    await dataRequest(workspace.close({ project: false }), 'Close local history', 5000);
  } catch {}
  serviceClosing = true;
  await dataService.dispose();
  workspaceReady = loadWorkspace(workspaceRoot);
  await within(workspaceReady, 15_000, 'Workspace restart');
  window.reload();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const args = process.argv.slice(2);
      const selected =
        process.env.PORTLEAF_WORKSPACE ||
        args.find((value) => !value.startsWith('-')) ||
        process.cwd();
      const target = path.resolve(selected);
      const targetStat = await stat(target);
      if (targetStat.isFile()) initialFile = path.basename(target);
      const root = targetStat.isDirectory() ? target : path.dirname(target);
      window = new BrowserWindow({
        width: 1000,
        height: 800,
        minWidth: 400,
        minHeight: 300,
        title: 'Portleaf',
        backgroundColor: '#1b2521',
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      });
      window.setMenu(null);
      window.webContents.setZoomFactor(1);
      window.webContents.setVisualZoomLevelLimits(1, 1);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      workspaceReady = loadWorkspace(root);
      protocol.handle('portleaf-resource', async (request) => {
        await workspaceReady;
        const url = new URL(request.url);
        if (
          !['image', 'file'].includes(url.hostname) ||
          request.method !== 'GET' ||
          url.searchParams.get('workspace') !== workspaceRoot
        )
          return new Response(null, { status: 404 });
        try {
          const file = await Promise.race([
            url.hostname === 'file'
              ? workspace.resourceFile(url.searchParams.get('path') ?? '')
              : workspace.imageFile(
                  url.searchParams.get('note') ?? '',
                  url.searchParams.get('src') ?? '',
                ),
            dataService.failure,
          ]);
          return resourceResponse(file, request, url.hostname === 'file');
        } catch {
          return new Response('Image unavailable', { status: 404 });
        }
      });
      handle('bootstrap', async () => {
        try {
          return { root: workspaceRoot, initialFile, settings: await settings() };
        } catch (error) {
          return {
            root: workspaceRoot,
            initialFile,
            settings: await settings({ ignoreUserConfig: true }),
            configurationError: `${String(error)} Using default settings; repair config.json and save it to reload.`,
          };
        }
      });
      ipcMain.on('connect', async (event) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          return;
        try {
          await within(workspaceReady, 15_000, 'Workspace initialization');
          await dataRequest(workspace.releaseAll());
          const { port1, port2 } = new MessageChannelMain();
          await dataRequest(dataService.connect(port1), 'Document connection');
          window.webContents.postMessage('repo-port', null, [port2]);
        } catch (error) {
          window.webContents.send('event', { type: 'data-unavailable', message: String(error) });
        }
      });
      handle('list', (directory?: string, options?: FileBrowseOptions) =>
        workspace.list(directory, options),
      );
      handle('browse', (directory: string, options?: FileBrowseOptions) =>
        workspace.browse(directory, options),
      );
      handle('preview', (file: string) => workspace.preview(file));
      handle('inspect', (file: string) => workspace.inspect(file));
      handle('watch-resource', (file: string, enabled: boolean) =>
        workspace.watchResource(file, enabled),
      );
      handle('mkdir', (directory: string) => workspace.mkdir(directory));
      handle('copy', (file: string, target: string) => workspace.copy(file, target));
      handle('open', (file: string) => workspace.open(file, true));
      handle('create', (file: string, retain = false) => workspace.create(file, retain));
      handle('release', (file: string, heads: UrlHeads, url?: AutomergeUrl) =>
        workspace.release(file, heads, url),
      );
      handle('diagnostics', () => workspace.metrics());
      handle(
        'save-recovery',
        (documents: unknown) => preserveRecovery(recoveryDocuments(documents)),
        false,
      );
      handle('restart', (documents: unknown) => restart(recoveryDocuments(documents)), false);
      handle('rename', (file: string, target: string) => workspace.rename(file, target));
      handle('open-link', async (file: string, target: string) => {
        if (target.startsWith('//') || target.includes('\\')) throw new Error('Unsupported link.');
        const url = new URL(target, pathToFileURL(path.resolve(workspaceRoot, file)));
        if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
          await shell.openExternal(url.href);
          return null;
        }
        if (url.protocol !== 'file:') throw new Error('Unsupported link protocol.');
        const info = await workspace.open(path.relative(workspaceRoot, fileURLToPath(url)));
        return { path: info.path, fragment: decodeURIComponent(url.hash.slice(1)) };
      });
      handle('flush', async (documents: { url: AutomergeUrl; heads: UrlHeads }[]) => {
        for (const doc of documents) await workspace.awaitHeads(doc.url, doc.heads);
        await workspace.flush(documents.map((doc) => doc.url));
      });
      handle('history', (file: string) => workspace.history(file));
      handle('restore', (file: string, heads: UrlHeads) => workspace.restore(file, heads));
      handle('theme', (theme: string) => selectTheme(theme));
      handle('quit', (documents: unknown = []) => requestQuit(recoveryDocuments(documents)), false);
      window.on('close', (event) => {
        if (!exiting) {
          event.preventDefault();
          window.webContents.send('event', { type: 'prepare-close' });
          if (!closeTimer && !shutdownTask)
            closeTimer = setTimeout(() => {
              closeTimer = undefined;
              void (async () => {
                const choice = await dialog.showMessageBox(window, {
                  type: 'warning',
                  title: 'Editor is not responding',
                  message: 'The editor has not responded to the close request.',
                  detail:
                    'You can keep waiting, or save the available local history and quit. Changes that have not reached local history may be unavailable while the editor is unresponsive.',
                  buttons: ['Keep waiting', 'Save available history and quit'],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true,
                });
                if (choice.response === 1) {
                  await preserveRecovery([]);
                  await requestQuit([]);
                }
              })().catch((error) => dialog.showErrorBox('Could not close Portleaf', String(error)));
            }, 10_000);
        }
      });
      window.webContents.on('render-process-gone', (_event, details) => {
        if (exiting || shutdownTask) return;
        clearTimeout(closeTimer);
        void (async () => {
          const choice = await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'Editor stopped',
            message: 'The editor process stopped unexpectedly.',
            detail: `${details.reason}. Available local history will be saved before reopening or quitting. Changes that had not reached local history may be unavailable.`,
            buttons: ['Reopen', 'Save available history and quit'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (choice.response === 0) await restart([]);
          else {
            await preserveRecovery([]);
            await requestQuit([]);
          }
        })().catch((error) => dialog.showErrorBox('Recovery failed', String(error)));
      });
      app.on('before-quit', (event) => {
        if (!exiting && window && !window.isDestroyed()) {
          event.preventDefault();
          window.close();
        }
      });
      window.on('focus', () => {
        void workspaceReady
          .then(() => Promise.race([workspace.rescan(), dataService.failure]))
          .catch((error) =>
            window.webContents.send('event', { type: 'error', message: error.message }),
          );
      });
      await mkdir(configRoot, { recursive: true });
      const configWatcher = watch([appearanceFile, path.join(configRoot, 'config.json')], {
        ignoreInitial: true,
      });
      configWatcher.on('error', (error) => {
        if (!window.isDestroyed())
          window.webContents.send('event', { type: 'error', message: String(error) });
      });
      configWatcher.on('all', () => {
        void settings()
          .then((value) => window.webContents.send('event', { type: 'settings', settings: value }))
          .catch((error) =>
            window.webContents.send('event', { type: 'error', message: error.message }),
          );
      });
      app.once('will-quit', () => {
        void configWatcher.close();
      });
      // Configuration edits after bootstrap must not fall into watcher initialization.
      await once(configWatcher, 'ready');
      await Promise.all([window.loadFile(path.join(__dirname, 'index.html')), workspaceReady]);
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}
