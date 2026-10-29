import { Repo, type DocHandle, type AutomergeUrl } from '@automerge/automerge-repo';
import { MessageChannelNetworkAdapter } from '@automerge/automerge-repo-network-messagechannel';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { standardKeymap, history } from '@codemirror/commands';
import {
  PluginHost,
  type Buffer,
  type DesktopAPI,
  type OpenFile,
  type Settings,
  type FileResource,
  type FileView,
  type RecoveryDocument,
  focusBuffer,
} from '@portleaf/core';
import { builtInPlugins } from '@portleaf/plugins';
import type { FileDoc } from '@portleaf/data-patchwork';
import { collaboration, compositionSafePort } from './collaboration.js';
import { bootstrapReady } from './bootstrap.js';

declare global {
  interface Window {
    portleaf: DesktopAPI;
  }
}
const api = window.portleaf;
const app = document.querySelector<HTMLDivElement>('#app')!;
const workspaceElement = app.querySelector<HTMLElement>('.workspace')!;
const filename = app.querySelector<HTMLElement>('.filename')!;
const mode = app.querySelector<HTMLElement>('.mode')!;
const position = app.querySelector<HTMLElement>('.position')!;
const message = app.querySelector<HTMLElement>('.message')!;
type BufferView = Buffer & {
  handle?: DocHandle<FileDoc>;
  binding?: ReturnType<PluginHost['createBuffer']>;
  element: HTMLElement;
  mode: string;
  readOnly?: Compartment;
  identity?: Compartment;
  provider?: string;
  fileView?: FileView;
  detail?: string;
};
const buffers = new Map<string, BufferView>();
const listeners = new Set<() => void>();
let active: BufferView | undefined;
let messageTimer: ReturnType<typeof setTimeout>;
let closing = false;
let opening: Promise<unknown> = Promise.resolve();
let dataFailure: string | undefined;
let rejectConnection: ((error: Error) => void) | undefined;

const balancedEditorMargin = ViewPlugin.define((view) => {
  let observer: ResizeObserver | undefined;
  let destroyed = false;
  view.requestMeasure({
    read: () => view.dom.querySelector<HTMLElement>('.cm-gutters'),
    write: (gutter) => {
      if (!gutter || destroyed) return;
      observer = new ResizeObserver((entries) => {
        const width = entries[0]?.borderBoxSize[0]?.inlineSize;
        if (width === undefined || width === 0) return;
        view.dom.style.setProperty('--gutter-width', `${width}px`);
        view.requestMeasure();
      });
      observer.observe(gutter);
    },
  });
  return {
    destroy: () => {
      destroyed = true;
      observer?.disconnect();
    },
  };
});

function snapshots(): RecoveryDocument[] {
  return [...buffers.values()]
    .filter((buffer) => buffer.handle && buffer.info)
    .map((buffer) => ({
      path: buffer.info!.path,
      url: buffer.handle!.url,
      heads: buffer.handle!.heads(),
      text: buffer.view?.state.doc.toString() ?? buffer.handle!.doc().content,
    }));
}

function showDataFailure(value: string) {
  dataFailure = value;
  rejectConnection?.(new Error(value));
  for (const buffer of buffers.values())
    buffer.view?.dispatch({
      effects: buffer.readOnly!.reconfigure([
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]),
    });
  let panel = app.querySelector<HTMLElement>('.recovery-panel');
  if (panel) return;
  panel = document.createElement('aside');
  panel.className = 'recovery-panel';
  panel.setAttribute('role', 'alert');
  const description = document.createElement('p');
  description.textContent =
    'Saving is unavailable. Your open text is kept here until you save a recovery copy or restart.';
  panel.append(description);
  const save = document.createElement('button'),
    reload = document.createElement('button');
  save.type = reload.type = 'button';
  save.textContent = 'Save recovery copy';
  reload.textContent = 'Save recovery and restart';
  save.onclick = () => {
    void api
      .saveRecovery(snapshots())
      .then((file) => report(`Recovery copy saved: ${file}`))
      .catch(report);
  };
  reload.onclick = () => {
    app.inert = true;
    void api.restart(snapshots()).catch((error) => {
      app.inert = false;
      report(error);
    });
  };
  panel.append(save, reload);
  app.append(panel);
  report(value);
  clearTimeout(messageTimer);
}
const unsubscribeFailure = api.onEvent((event) => {
  if (event.type === 'data-unavailable')
    showDataFailure(event.message ?? 'The data service stopped.');
});
window.addEventListener('unload', unsubscribeFailure, { once: true });

function report(error: unknown) {
  message.textContent =
    error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
      : String(error);
  message.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message.hidden = true;
  }, 12_000);
}
function status() {
  if (active) {
    mode.textContent = active.mode;
    filename.textContent = active.info
      ? active.info.path +
        (active.info.deleted ? ' [detached]' : active.info.readOnly ? ' [read only]' : '')
      : 'No file';
    if (active.view) {
      const state = active.view.state,
        line = state.doc.lineAt(state.selection.main.head);
      position.textContent = `${line.number}:${state.selection.main.head - line.from + 1}`;
    } else position.textContent = active.detail ?? '';
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      report(error);
    }
  }
}
function activate(buffer: Buffer) {
  if (active) {
    active.element.hidden = true;
    active.fileView?.setActive(false);
  }
  active = buffer as BufferView;
  active.element.hidden = false;
  active.view?.requestMeasure();
  active.fileView?.setActive(true);
  focusBuffer(active);
  document.title = active.info ? `${active.info.path} — Portleaf` : 'Portleaf';
  status();
}
function createView(info?: OpenFile, handle?: DocHandle<FileDoc>): BufferView {
  const element = document.createElement('section');
  element.className = 'buffer';
  element.hidden = true;
  workspaceElement.append(element);
  const readOnly = new Compartment(),
    identity = new Compartment();
  let view: EditorView;
  const buffer = {
    info,
    handle,
    element,
    readOnly,
    identity,
    mode: 'EDIT',
    get view() {
      return view;
    },
    setMode(value: string) {
      buffer.mode = value;
      if (active === buffer) status();
    },
    resource(target: string) {
      if (/^https?:/i.test(target) || /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(target))
        return target;
      if (!buffer.info || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return;
      const resource = new URL('portleaf-resource://image/');
      resource.searchParams.set('workspace', bootstrap.root);
      resource.searchParams.set('note', buffer.info.path);
      resource.searchParams.set('src', target);
      return resource.href;
    },
  };
  const binding = host.createBuffer(buffer);
  view = new EditorView({
    parent: element,
    doc: handle?.doc().content ?? '',
    extensions: [
      binding.extension,
      drawSelection(),
      history(),
      lineNumbers(),
      balancedEditorMargin,
      EditorView.lineWrapping,
      readOnly.of([
        EditorState.readOnly.of(!handle || !!info?.readOnly || !!dataFailure),
        ...(dataFailure ? [EditorView.editable.of(false)] : []),
      ]),
      keymap.of(standardKeymap),
      identity.of(
        EditorView.contentAttributes.of({
          'aria-label': info?.path ?? 'Markdown editor',
          spellcheck: 'false',
        }),
      ),
      EditorView.updateListener.of(() => {
        if (active === buffer) status();
      }),
      EditorView.exceptionSink.of(report),
      handle
        ? collaboration(handle)
        : placeholder('Files: Space f f\nCommands: Space Space\nKeyboard shortcuts: Space ?'),
    ],
  });
  binding.attach(view);
  return Object.assign(buffer, { binding });
}
function resourceURL(file: string) {
  const url = new URL('portleaf-resource://file/');
  url.searchParams.set('workspace', bootstrap.root);
  url.searchParams.set('path', file);
  return url.href;
}
function createFileView(info: FileResource, provider: string): BufferView {
  const element = document.createElement('section');
  element.className = 'buffer';
  element.hidden = true;
  workspaceElement.append(element);
  const buffer: BufferView = {
    info,
    element,
    provider,
    mode: 'VIEW',
    focus: () => buffer.fileView?.focus(),
    resource: () => resourceURL(info.path),
    setMode(value) {
      buffer.mode = value;
      if (active === buffer) status();
    },
  };
  try {
    buffer.fileView = host.createFileView(provider, {
      parent: element,
      file: info,
      resource: () => resourceURL(info.path),
      setStatus(value, detail) {
        buffer.mode = value;
        buffer.detail = detail;
        if (active === buffer) status();
      },
    });
  } catch (error) {
    element.remove();
    throw error;
  }
  return buffer;
}
async function flush(file?: string) {
  await api.flush(
    [...buffers.values()]
      .filter((buffer) => buffer.handle && (!file || buffer.info?.path === file))
      .map((buffer) => ({
        url: buffer.handle!.url,
        heads: buffer.handle!.heads(),
      })),
  );
}
async function open(file: string, create = false, options?: { replaceActive?: boolean }) {
  opening = opening
    .catch(() => {})
    .then(async () => {
      const replacing = options?.replaceActive ? active : undefined;
      const reveal = async (buffer: BufferView) => {
        activate(buffer);
        if (replacing?.info && replacing !== buffer) await removeBuffer(replacing);
      };
      if (buffers.has(file)) {
        await reveal(buffers.get(file)!);
        return;
      }
      const inspected = !create ? await api.inspect(file).catch(() => undefined) : undefined;
      const canonical = inspected?.path ?? file;
      const knownProvider = host.viewerFor(canonical, false);
      const provider = !create && host.viewerFor(canonical);
      if (knownProvider && !provider)
        throw new Error(
          create
            ? 'Create PDF and image files with an external tool.'
            : `Enable the ${knownProvider} plugin to view this file.`,
        );
      if (provider) {
        const info = inspected ?? (await api.inspect(file));
        const existing = buffers.get(info.path);
        if (existing) {
          await reveal(existing);
          return;
        }
        const buffer = createFileView(info, provider);
        buffers.set(info.path, buffer);
        await reveal(buffer);
        return;
      }
      const info = create ? await api.create(file, true) : await api.open(file);
      const existing = buffers.get(info.path);
      if (existing) {
        await api.release(info.path, existing.handle!.heads(), existing.handle!.url);
        await reveal(existing);
        return;
      }
      try {
        const handle = await repo.find<FileDoc>(info.url as AutomergeUrl);
        const buffer = createView(info, handle);
        buffers.set(info.path, buffer);
        await reveal(buffer);
      } catch (error) {
        if (!buffers.has(info.path)) await api.release(info.path, [], info.url);
        throw error;
      }
    });
  await opening;
}
async function renameFile(file: string, target: string) {
  if (host.viewerFor(target, false)) throw new Error('Choose a text-file extension for rename.');
  await flush(file);
  const renamed = await api.rename(file, target);
  applyRename(file, renamed);
  return renamed;
}
function applyRename(file: string, renamed: string) {
  const buffer = buffers.get(file);
  if (buffer?.info) {
    buffers.delete(file);
    buffer.info.path = renamed;
    buffers.set(renamed, buffer);
    buffer.view?.dispatch({
      effects: buffer.identity!.reconfigure(
        EditorView.contentAttributes.of({ 'aria-label': renamed, spellcheck: 'false' }),
      ),
    });
    buffer.binding?.refresh();
    if (buffer === active) document.title = `${renamed} — Portleaf`;
    status();
  }
}
async function closeBuffer() {
  await opening;
  const buffer = active;
  if (!buffer?.info) return;
  await removeBuffer(buffer);
}
async function removeBuffer(buffer: BufferView) {
  if (buffer.view?.composing) {
    buffer.view.contentDOM.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (buffer.view.composing)
      throw new Error('Finish text composition before closing this buffer.');
  }
  buffer.element.inert = true;
  try {
    if (buffer.handle) {
      const result = await api.release(buffer.info!.path, buffer.handle.heads(), buffer.handle.url);
      if (result.warning) report(result.warning);
    }
  } catch (error) {
    if (!dataFailure) {
      buffer.element.inert = false;
      throw error;
    }
    try {
      const file = await api.saveRecovery(
        snapshots().filter((doc) => doc.url === buffer.handle?.url),
      );
      report(`Recovery copy saved: ${file}`);
    } catch (recoveryError) {
      buffer.element.inert = false;
      throw recoveryError;
    }
  }
  const views = [...buffers.values()],
    index = views.indexOf(buffer);
  buffers.delete(buffer.info!.path);
  if (active === buffer) activate(views[index + 1] ?? views[index - 1] ?? empty);
  buffer.binding?.destroy();
  buffer.view?.destroy();
  buffer.fileView?.destroy();
  buffer.element.remove();
  if (buffer.handle) await repo.removeFromCache(buffer.handle.documentId);
}
async function quit() {
  if (closing) return;
  closing = true;
  try {
    await opening;
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if ([...buffers.values()].some((buffer) => buffer.view?.composing))
      throw new Error('Finish text composition before quitting.');
    app.inert = true;
    const exiting = await api.quit(snapshots());
    if (!exiting) {
      closing = false;
      app.inert = false;
      focusBuffer(active);
    }
  } catch (error) {
    closing = false;
    app.inert = false;
    focusBuffer(active);
    throw error;
  }
}
let configurationRevision = 0;
let configurationKey = '';
async function configure(settings: Settings) {
  const revision = ++configurationRevision;
  const key = JSON.stringify(settings);
  if (key === configurationKey) return;
  await host.prepare(settings);
  if (revision !== configurationRevision) return;
  host.configure(settings);
  for (const buffer of buffers.values())
    if (buffer.provider && !host.hasViewer(buffer.provider)) await removeBuffer(buffer);
  configurationKey = key;
  status();
}
const bootstrap = await bootstrapReady;
app.querySelector<HTMLElement>('.workspace-name')!.textContent = bootstrap.root;
const host = new PluginHost(builtInPlugins, {
  root: app,
  status: app.querySelector<HTMLElement>('.plugin-status')!,
  files: api,
  buffers: {
    active: () => active,
    list: () => [...buffers.values()],
    open,
    activate,
    close: closeBuffer,
    rename: renameFile,
    flush,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  },
  report,
  quit,
  setTheme: async (theme) => {
    if (!host.themeNames.includes(theme)) throw new Error(`Unknown theme: ${theme}`);
    await configure(await api.setTheme(theme));
  },
});
try {
  await configure(bootstrap.settings);
} catch (error) {
  report(error);
  await configure({
    ...bootstrap.settings,
    plugins: builtInPlugins.filter((plugin) => !plugin.theme).map((plugin) => plugin.id),
    theme: 'minimal',
    fontFamily: 'monospace',
    fontSize: 14,
  });
}
if (bootstrap.configurationError) report(bootstrap.configurationError);
const repo = new Repo();
const ready = new Promise<void>((resolve, reject) => {
  const finish = (error?: Error) => {
    clearTimeout(timer);
    window.removeEventListener('message', receive);
    rejectConnection = undefined;
    if (error) reject(error);
    else resolve();
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window || event.data?.type !== 'portleaf-repo' || !event.ports[0]) return;
    repo.networkSubsystem.addNetworkAdapter(
      new MessageChannelNetworkAdapter(compositionSafePort(event.ports[0])),
    );
    finish();
  };
  const timer = setTimeout(() => {
    const error = new Error('Document connection timed out. Save a recovery copy or restart.');
    showDataFailure(error.message);
    finish(error);
  }, 20_000);
  rejectConnection = (error) => finish(error);
  window.addEventListener('message', receive);
  if (dataFailure) finish(new Error(dataFailure));
});
api.connect();
await ready;
const empty = createView();
activate(empty);
const unsubscribe = api.onEvent((event) => {
  if (event.type === 'renamed' && event.file && event.previousFile)
    applyRename(event.previousFile, event.file);
  if (event.type === 'prepare-close') void quit().catch(report);
  if (event.type === 'error' || event.type === 'deleted')
    report(event.message ?? 'The file is unavailable.');
  if (event.type === 'deleted') {
    const buffer = buffers.get(event.file ?? '');
    if (buffer?.info) buffer.info.deleted = true;
    status();
  }
  if (event.type === 'changed') {
    const buffer = buffers.get(event.file ?? '');
    if (buffer?.info) {
      buffer.info.deleted = false;
      buffer.info.readOnly = !!event.readOnly;
      buffer.view?.dispatch({
        effects: buffer.readOnly!.reconfigure([
          EditorState.readOnly.of(!!event.readOnly || !!dataFailure),
          ...(dataFailure ? [EditorView.editable.of(false)] : []),
        ]),
      });
      status();
    }
  }
  if (event.type === 'settings' && event.settings) {
    void configure(event.settings).catch(report);
  }
});
window.addEventListener('unload', () => {
  unsubscribe();
  clearTimeout(messageTimer);
  for (const buffer of [empty, ...buffers.values()]) {
    buffer.binding?.destroy();
    buffer.view?.destroy();
    buffer.fileView?.destroy();
  }
  host.destroy();
});
if (bootstrap.initialFile) await open(bootstrap.initialFile).catch(report);
else if (host.commandList.some((command) => command.id === 'files.open'))
  await host.execute('files.open').catch(report);
