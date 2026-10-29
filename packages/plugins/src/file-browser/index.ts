import { manifest } from './manifest.js';
import { focusBuffer, type CommandTarget, type Plugin } from '@portleaf/core';
import { createFileBrowser } from './panel.js';
import './style.css';
import { isMarkdownFile } from '../shared/file-types.js';

const parent = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');
const inFolder = (directory: string, name: string) =>
  directory === '.' ? name : `${directory}/${name}`;
const markdownName = (name: string) => (/\.(md|markdown|mdown)$/i.test(name) ? name : `${name}.md`);

export const fileBrowserPlugin: Plugin = {
  ...manifest,
  activate(context) {
    const { files, buffers, picker } = context;
    const viewerFormat = (name: string) =>
      [
        ...(context.fileBrowsing.extensions ?? []),
        ...(context.fileBrowsing.excludedExtensions ?? []),
      ].includes(name.split('.').at(-1)?.toLowerCase() ?? '');
    const browser = createFileBrowser(context.root, {
      api: files,
      isResource: (file) =>
        context.fileBrowsing.extensions?.includes(file.split('.').at(-1)?.toLowerCase() ?? '') ??
        false,
      history: () => context.commands.has('history.open'),
      open: buffers.open,
      action: (id, entry, directory) =>
        context.commands.execute(id, {
          file: entry && !entry.directory ? entry.path : undefined,
          directory,
          onClose: browser.focus,
          afterRun: (file) => browser.refresh(file),
        }),
      onClose: () => focusBuffer(buffers.active()),
      onError: context.report,
    });
    context.onDispose(browser.destroy);
    context.registerCommand('files.open', () => browser.show(buffers.active()?.info?.path));
    async function fileAction(id: string, target?: CommandTarget) {
      const file = target ? target.file : buffers.active()?.info?.path;
      const directory = target?.directory ?? (file ? parent(file) : browser.directory);
      const done = target?.onClose;
      if (id === 'files.create' || id === 'files.mkdir') {
        picker.prompt(
          id === 'files.mkdir'
            ? 'New directory'
            : context.fileBrowsing.text
              ? 'New file'
              : 'New Markdown file',
          '',
          async (name) => {
            const filename =
              context.fileBrowsing.text && /\.[^./]+$/.test(name) ? name : markdownName(name);
            const path = inFolder(directory, id === 'files.mkdir' ? name : filename);
            if (id === 'files.mkdir') await files.mkdir(path);
            else if (target?.afterRun) await files.create(path);
            else await buffers.open(path, true);
            await target?.afterRun?.(path);
          },
          done,
        );
        return;
      }
      if (!file) throw new Error('Select a text file.');
      if (context.fileBrowsing.extensions?.includes(file.split('.').at(-1)?.toLowerCase() ?? ''))
        throw new Error('File rename and copy are available for text documents.');
      const name = file.split('/').at(-1)!;
      const dot = name.lastIndexOf('.');
      picker.prompt(
        id === 'files.copy' ? 'Copy to new file' : 'Rename file',
        id === 'files.copy'
          ? dot > 0
            ? `${name.slice(0, dot)} copy${name.slice(dot)}`
            : `${name} copy`
          : name,
        async (name) => {
          const filename =
            !isMarkdownFile(file) || (context.fileBrowsing.text && /\.[^./]+$/.test(name))
              ? name
              : markdownName(name);
          if (id !== 'files.mkdir' && viewerFormat(filename))
            throw new Error('Create PDF and image files with an external tool.');
          const path = inFolder(parent(file), filename);
          if (viewerFormat(filename))
            throw new Error('Choose a text-file extension for copy or rename.');
          await buffers.flush(file);
          if (id === 'files.rename') await buffers.rename(file, path);
          else {
            const info = await files.copy(file, path);
            if (!target?.afterRun) await buffers.open(info.path);
          }
          await target?.afterRun?.(path);
        },
        done,
      );
    }
    for (const id of ['files.create', 'files.rename', 'files.copy', 'files.mkdir'])
      context.registerCommand(id, (target) => fileAction(id, target));
    let timer: ReturnType<typeof setTimeout>;
    context.onDispose(
      files.onEvent((event) => {
        if ((event.type === 'files' || event.type === 'settings') && browser.visible) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            void browser.refresh().catch(context.report);
          }, 50);
        }
      }),
    );
    context.onDispose(() => clearTimeout(timer));
    let policy = JSON.stringify(context.fileBrowsing);
    context.onDispose(
      buffers.subscribe(() => {
        if (policy === JSON.stringify(context.fileBrowsing)) return;
        policy = JSON.stringify(context.fileBrowsing);
        if (browser.visible) void browser.refresh().catch(context.report);
      }),
    );
  },
};
