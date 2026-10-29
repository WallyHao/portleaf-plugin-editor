import fuzzysort from 'fuzzysort';
import {
  renderRows,
  renderKeyHints,
  type Choice,
  type DesktopAPI,
  type FileEntry,
} from '@portleaf/core';

import { fileBrowserKeys } from './manifest.js';
const parent = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');
const visiblePath = (file: string) => file.split('/').every((part) => !part.startsWith('.'));

export function createFileBrowser(
  root: HTMLElement,
  options: {
    api: Pick<DesktopAPI, 'browse' | 'preview' | 'list' | 'inspect'>;
    isResource?(file: string): boolean;
    history?(): boolean;
    open(file: string): Promise<void>;
    action(id: string, entry: FileEntry | undefined, directory: string): Promise<void>;
    onClose(): void;
    onError(error: unknown): void;
  },
) {
  const panel = document.createElement('section');
  panel.className = 'picker file-browser';
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'File selector');
  panel.innerHTML =
    '<div class="picker-label browser-path"></div><div class="browser-columns"><div id="file-options" class="picker-list browser-list" role="listbox" aria-label="Files"></div><pre class="picker-preview browser-preview" aria-label="File preview"></pre></div><input class="picker-input browser-search" aria-label="Search file names" placeholder="/ Search file names" spellcheck="false" hidden><div class="picker-hint"></div>';
  root.append(panel);
  const label = panel.querySelector<HTMLElement>('.browser-path')!;
  const list = panel.querySelector<HTMLElement>('.browser-list')!;
  const preview = panel.querySelector<HTMLElement>('.browser-preview')!;
  const search = panel.querySelector<HTMLInputElement>('.browser-search')!;
  let directory = '.',
    entries: FileEntry[] = [],
    shown: FileEntry[] = [];
  let selected = 0,
    generation = 0,
    previewGeneration = 0,
    top = false;
  let allFiles: string[] | undefined;
  let requestedSelection: string | undefined;
  let requestedReveal = false;
  let disposed = false;
  let choices: Choice[] = [];
  let previewTimer: ReturnType<typeof setTimeout>;
  let previewPath: string | undefined;
  let indexPromise: Promise<string[]> | undefined;
  let windowStart = -1;
  let ready: Promise<void> = Promise.resolve();
  let inputQueue: Promise<void> = Promise.resolve();
  const previews = new Map<string, string>();
  const focus = () => {
    if (!panel.hidden) panel.focus();
  };
  function close() {
    if (panel.hidden) return;
    generation++;
    previewGeneration++;
    clearTimeout(previewTimer);
    panel.hidden = true;
    options.onClose();
  }
  function updatePreview(entry?: FileEntry) {
    if (entry && entry.path === previewPath) return;
    previewPath = entry?.path;
    const version = ++previewGeneration;
    clearTimeout(previewTimer);
    if (!entry) {
      preview.textContent = 'No files or directories';
      return;
    }
    const cached = previews.get(entry.path);
    if (cached !== undefined) {
      preview.textContent = cached;
      preview.scrollTop = 0;
      return;
    }
    previewTimer = setTimeout(() => {
      void readPreview(entry, version);
    }, 60);
  }
  async function readPreview(entry: FileEntry, version: number) {
    try {
      const value = entry.directory
        ? (await options.api.browse(entry.path))
            .filter((child) => visiblePath(child.path))
            .map((child) => child.name + (child.directory ? '/' : ''))
            .join('\n') || 'Empty directory'
        : options.isResource?.(entry.path)
          ? await options.api
              .inspect(entry.path)
              .then(
                (file) =>
                  `${entry.name}\n\n${file.size.toLocaleString()} bytes\n\nEnter to view · read only`,
              )
          : await options.api.preview(entry.path);
      if (version === previewGeneration) {
        if (previews.size >= 20) previews.delete(previews.keys().next().value!);
        previews.set(entry.path, value);
        preview.textContent = value;
        preview.scrollTop = 0;
      }
    } catch (error) {
      if (version === previewGeneration)
        preview.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  function renderSelection(reveal = true) {
    const height = Number.parseFloat(getComputedStyle(list).lineHeight) || 28;
    let scrollTop = list.scrollTop;
    if (reveal) {
      if (selected * height < scrollTop) scrollTop = selected * height;
      else if ((selected + 1) * height > scrollTop + list.clientHeight)
        scrollTop = (selected + 1) * height - list.clientHeight;
    }
    scrollTop = Math.max(0, Math.min(scrollTop, shown.length * height - list.clientHeight));
    const offset = shown.length > 200 ? Math.max(0, Math.floor(scrollTop / height) - 14) : 0;
    const end = shown.length > 200 ? Math.min(shown.length, offset + 56) : shown.length;
    list.querySelectorAll('.browser-spacer').forEach((element) => element.remove());
    renderRows(
      list,
      offset === 0 && end === choices.length ? choices : choices.slice(offset, end),
      selected - offset,
      (index) => {
        selected = index + offset;
        void enter().catch(options.onError);
      },
      offset,
      false,
      shown.length,
    );
    for (const [count, first] of [
      [offset, true],
      [shown.length - end, false],
    ] as const) {
      if (!count) continue;
      const spacer = document.createElement('div');
      spacer.className = 'browser-spacer';
      spacer.style.height = `calc(${count} * var(--row))`;
      spacer.setAttribute('aria-hidden', 'true');
      if (first) list.prepend(spacer);
      else list.append(spacer);
    }
    windowStart = offset;
    list.scrollTop = scrollTop;
    if (!shown.length) list.textContent = search.value ? 'No matches' : 'Empty directory';
    if (selected >= offset && selected < end)
      list.setAttribute('aria-activedescendant', `${list.id}-option-${selected}`);
    else list.removeAttribute('aria-activedescendant');
    updatePreview(shown[selected]);
  }
  list.onscroll = () => {
    const height = Number.parseFloat(getComputedStyle(list).lineHeight) || 28;
    if (shown.length > 200 && Math.max(0, Math.floor(list.scrollTop / height) - 14) !== windowStart)
      renderSelection(false);
  };
  function render(prefer?: string, reveal = true) {
    renderKeyHints(
      panel.querySelector<HTMLElement>('.picker-hint')!,
      fileBrowserKeys.filter(([key]) => key !== 'H' || options.history?.() !== false),
      3,
    );
    const base = directory === '.' ? '' : directory + '/';
    shown =
      search.value && allFiles
        ? fuzzysort
            .go(
              search.value,
              allFiles.filter((file) => file.startsWith(base)),
              { all: true, limit: 200 },
            )
            .map((result) => ({
              name: result.target.slice(base.length),
              path: result.target,
              directory: false,
            }))
        : entries;
    const preferred = prefer ? shown.findIndex((entry) => entry.path === prefer) : -1;
    selected = Math.max(0, Math.min(preferred >= 0 ? preferred : selected, shown.length - 1));
    label.textContent = `Files · ${directory === '.' ? '/' : directory} ${search.value ? '· Search: ' + search.value : ''}`;
    choices = shown.map((entry) => ({
      label: entry.name + (entry.directory ? '/' : ''),
      detail: entry.deleted ? '[detached]' : entry.directory ? 'directory' : '',
      run() {},
    }));
    renderSelection(reveal);
  }
  async function refresh(prefer?: string) {
    if (disposed || panel.hidden) return;
    if (prefer !== undefined) requestedReveal = true;
    requestedSelection = prefer ?? requestedSelection ?? shown[selected]?.path;
    const version = ++generation;
    const value = await options.api.browse(directory);
    if (search.value && !indexPromise)
      indexPromise = options.api.list(directory).finally(() => {
        indexPromise = undefined;
      });
    const files = search.value ? await indexPromise : undefined;
    if (version !== generation || panel.hidden) return;
    previews.clear();
    previewPath = undefined;
    entries = value.filter((entry) => visiblePath(entry.path));
    allFiles = files?.filter(visiblePath);
    render(requestedSelection, requestedReveal);
    requestedSelection = undefined;
    requestedReveal = false;
  }
  async function enter() {
    const entry = shown[selected];
    if (!entry) return;
    if (entry.directory) {
      directory = entry.path;
      requestedSelection = undefined;
      search.value = '';
      search.hidden = true;
      selected = 0;
      list.scrollTop = 0;
      await refresh();
      focus();
    } else {
      await options.open(entry.path);
      close();
    }
  }
  async function leave() {
    if (directory === '.') return;
    const previous = directory;
    directory = parent(directory);
    search.value = '';
    search.hidden = true;
    await refresh(previous);
    focus();
  }
  search.oninput = () => {
    selected = 0;
    list.scrollTop = 0;
    if (allFiles) render();
    else void refresh().catch(options.onError);
  };
  search.onkeydown = (event) => {
    if (event.isComposing) return;
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      focus();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      search.value = '';
      search.hidden = true;
      render();
      focus();
    }
  };
  async function handleKey(key: string, repeat: boolean) {
    if (repeat && !['j', 'k', 'ArrowDown', 'ArrowUp'].includes(key)) return;
    if (key === 'g') {
      if (top) {
        selected = 0;
        renderSelection();
      }
      top = !top;
      return;
    }
    top = false;
    if (['j', 'k', 'ArrowDown', 'ArrowUp', 'G'].includes(key)) {
      selected =
        key === 'G'
          ? shown.length - 1
          : Math.max(
              0,
              Math.min(selected + (['j', 'ArrowDown'].includes(key) ? 1 : -1), shown.length - 1),
            );
      renderSelection();
      requestedSelection = shown[selected]?.path;
    } else if (['l', 'ArrowRight', 'Enter'].includes(key)) await enter();
    else if (['h', 'ArrowLeft'].includes(key)) await leave();
    else if (key === 'q' || key === 'Escape') {
      if (search.value) {
        search.value = '';
        search.hidden = true;
        render();
      } else close();
    } else if (key === '/') {
      search.hidden = false;
      search.focus();
      search.select();
    } else {
      const id = {
        n: 'files.create',
        r: 'files.rename',
        c: 'files.copy',
        H: 'history.open',
        m: 'files.mkdir',
      }[key];
      if (key === 'H' && options.history?.() === false) return;
      if (id) await options.action(id, shown[selected], directory);
    }
  }
  panel.onkeydown = (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const { key, repeat } = event;
    inputQueue = inputQueue
      .then(async () => {
        await ready;
        if (!disposed && !panel.hidden) await handleKey(key, repeat);
      })
      .catch(options.onError);
  };

  return {
    async show(file?: string) {
      if (disposed) return;
      if (file && !visiblePath(file)) {
        file = undefined;
        directory = '.';
      }
      if (file) directory = parent(file);
      panel.hidden = false;
      requestedSelection = file;
      search.value = '';
      search.hidden = true;
      selected = 0;
      list.scrollTop = 0;
      allFiles = undefined;
      ready = refresh(file);
      focus();
      await ready;
      focus();
    },
    refresh,
    focus,
    close,
    destroy() {
      close();
      disposed = true;
      generation++;
      previewGeneration++;
      clearTimeout(previewTimer);
      previews.clear();
      panel.remove();
    },
    get directory() {
      return directory;
    },
    get visible() {
      return !panel.hidden;
    },
  };
}
