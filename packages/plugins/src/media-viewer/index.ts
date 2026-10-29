import {
  createCommandKeys,
  type FileViewContext,
  type FileView,
  type Plugin,
  type PluginContext,
} from '@portleaf/core';
import { manifest, imageExtensions } from './manifest.js';
import { fitScale, viewerOptions, type FitMode } from './model.js';
import type { PDFReader, SearchHit } from './pdf.js';
import './style.css';

type Action =
  | 'next'
  | 'previous'
  | 'fit'
  | 'width'
  | 'actual'
  | 'zoom-in'
  | 'zoom-out'
  | 'rotate'
  | 'reload'
  | 'search'
  | 'outline'
  | 'goto';
type Controller = FileView & { run(action: Action): Promise<void> };
const instances = new WeakMap<PluginContext, Map<string, Controller>>();
const isImage = (file: string) =>
  (imageExtensions as readonly string[]).includes(file.split('.').at(-1)?.toLowerCase() ?? '');
const folder = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');

export function createMediaView(context: FileViewContext): Controller {
  const { app, parent, file } = context;
  const isPDF = /\.pdf$/i.test(file.path);
  const root = document.createElement('div');
  root.className = 'media-viewer';
  root.dataset.kind = isPDF ? 'pdf' : 'image';
  root.innerHTML =
    '<div class="media-viewport" tabindex="0" role="region"><div class="media-stage"></div></div><div class="media-controls"><button type="button" data-action="previous" title="Previous page or image">‹</button><button type="button" data-action="next" title="Next page or image">›</button><button type="button" data-action="fit">Fit</button><button type="button" data-action="actual">1:1</button><button type="button" data-action="rotate">Rotate</button><button type="button" data-action="outline">Index</button><span class="muted media-help"></span></div>';
  const viewport = root.querySelector<HTMLElement>('.media-viewport')!;
  viewport.setAttribute('aria-label', isPDF ? 'PDF viewer' : 'Image viewer');
  const stage = root.querySelector<HTMLElement>('.media-stage')!;
  root.querySelector<HTMLElement>('.media-help')!.textContent = isPDF
    ? 'J/K Pages · hjkl Pan · +/- Zoom · / Search · q Close'
    : '←/→ Images · hjkl Pan · i/o Zoom · s Fit · q Close';
  parent.append(root);
  const commandKeys = createCommandKeys(root, app.commands, app.report);
  let active = false,
    disposed = false;
  let pdf: PDFReader | undefined;
  let image: HTMLImageElement | undefined;
  let loading: Promise<void> | undefined;
  let controller = new AbortController();
  let page = 1,
    count = 1,
    rotation = 0,
    scale = 1;
  let mode: FitMode = 'fit';
  let renderedScale = 1;
  let imageFiles: string[] = [file.path];
  let generation = 0,
    renderRevision = 0,
    operationRevision = 0;
  let query = '',
    hits: SearchHit[] = [],
    selectedHit = -1;
  let digits = '',
    previousG = false,
    ownsPicker = false;
  let resizeTimer: ReturnType<typeof setTimeout>;
  let reloadTimer: ReturnType<typeof setTimeout>;
  let neighborQueue: Promise<unknown> = Promise.resolve();
  function current() {
    return active && !disposed && !app.signal.aborted;
  }
  function options() {
    return viewerOptions(app.settings.pluginSettings?.['media-viewer']);
  }
  function status() {
    const index = isPDF ? page : Math.max(1, imageFiles.indexOf(file.path) + 1);
    const total = isPDF ? count : imageFiles.length;
    context.setStatus(
      isPDF ? 'PDF' : 'IMAGE',
      index + '/' + total + ' · ' + Math.round(scale * 100) + '%',
    );
    root.dataset.page = String(index);
    root.dataset.rotation = String(rotation);
    root.dataset.zoom = String(scale);
  }
  function clearPaper() {
    stage.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    stage.replaceChildren();
  }
  function notice(value: string, state = 'loading') {
    clearPaper();
    const message = document.createElement('p');
    message.className = 'media-notice';
    message.setAttribute('role', 'status');
    message.textContent = value;
    stage.append(message);
    root.dataset.state = state;
  }
  function fail(error: unknown) {
    if (!current()) return;
    notice(
      (error instanceof Error ? error.message : String(error)) +
        ' · Press R to retry or q to close.',
      'error',
    );
  }
  async function refreshImages() {
    if (isPDF) return;
    const entries = await app.files.browse(folder(file.path), { extensions: [...imageExtensions] });
    if (disposed) return;
    imageFiles = entries
      .filter((entry) => !entry.directory && !entry.deleted && isImage(entry.path))
      .map((entry) => entry.path);
    if (!imageFiles.includes(file.path)) imageFiles.push(file.path);
    imageFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    status();
  }
  async function redraw(reset = false) {
    if (!current()) return;
    const version = ++renderRevision;
    const source = pdf;
    source?.cancelRender();
    try {
      const size = source
        ? await source.size(page, rotation)
        : image
          ? rotation % 180
            ? { width: image.naturalHeight, height: image.naturalWidth }
            : { width: image.naturalWidth, height: image.naturalHeight }
          : undefined;
      if (!size || version !== renderRevision || !current()) return;
      const previousScale = renderedScale;
      scale = fitScale(
        mode,
        size.width,
        size.height,
        Math.max(1, viewport.clientWidth - 32),
        Math.max(1, viewport.clientHeight - 32),
        scale,
      );
      const left = viewport.scrollLeft,
        top = viewport.scrollTop;
      const paper = document.createElement('div');
      paper.className = 'media-paper';
      paper.style.width = size.width * scale + 'px';
      paper.style.height = size.height * scale + 'px';
      clearPaper();
      stage.append(paper);
      root.dataset.state = 'rendering';
      root.dataset.background = options().imageBackground;
      status();
      if (source) {
        const rendered = await source.render(
          page,
          rotation,
          scale,
          options().maxCanvasPixels,
          paper,
          query,
          hits[selectedHit]?.page === page ? hits[selectedHit].offset : undefined,
        );
        if (!rendered || version !== renderRevision || !current()) return;
      } else if (image) {
        image.style.width = image.naturalWidth * scale + 'px';
        image.style.height = image.naturalHeight * scale + 'px';
        image.style.transform = 'translate(-50%, -50%) rotate(' + rotation + 'deg)';
        paper.append(image);
      }
      root.dataset.state = 'ready';
      renderedScale = scale;
      viewport.scrollLeft = reset ? 0 : (left * scale) / previousScale;
      viewport.scrollTop = reset ? 0 : (top * scale) / previousScale;
      paper
        .querySelector('.media-match.selected')
        ?.scrollIntoView({ block: 'center', inline: 'nearest' });
      status();
    } catch (error) {
      if (version === renderRevision) fail(error);
    }
  }
  async function load() {
    const version = ++generation;
    operationRevision++;
    query = '';
    hits = [];
    selectedHit = -1;
    if (ownsPicker) {
      app.picker.close();
      ownsPicker = false;
    }
    renderRevision++;
    controller.abort();
    controller = new AbortController();
    pdf?.destroy();
    pdf = undefined;
    image?.removeAttribute('src');
    image = undefined;
    notice('Loading ' + file.path + '…');
    const signal = controller.signal;
    try {
      const metadata = await app.files.inspect(file.path);
      if (signal.aborted || !current()) return;
      const url = new URL(context.resource());
      url.searchParams.set('revision', String(Date.now()));
      if (isPDF) {
        const module = await import('./pdf.js');
        if (signal.aborted) return;
        const reader = await module.openPDF(url.href, signal, metadata.size);
        if (signal.aborted || version !== generation) {
          reader.destroy();
          return;
        }
        pdf = reader;
        count = reader.pages;
        page = Math.min(page, count);
      } else {
        const candidate = new Image();
        candidate.className = 'media-image';
        candidate.alt = file.path;
        candidate.draggable = false;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            candidate.removeAttribute('src');
            reject(new DOMException('Viewer closed', 'AbortError'));
          };
          signal.addEventListener('abort', abort, { once: true });
          candidate.onload = () => {
            signal.removeEventListener('abort', abort);
            resolve();
          };
          candidate.onerror = () => {
            signal.removeEventListener('abort', abort);
            reject(new Error('Cannot decode this image'));
          };
          candidate.src = url.href;
        });
        candidate.onload = null;
        candidate.onerror = null;
        if (signal.aborted || version !== generation) {
          candidate.removeAttribute('src');
          return;
        }
        image = candidate;
        await refreshImages();
      }
      if (current()) await redraw(true);
    } catch (error) {
      if (!signal.aborted && version === generation) fail(error);
    }
  }
  function ensureLoaded() {
    if (loading) return loading;
    loading = load().finally(() => {
      loading = undefined;
      if (current() && controller.signal.aborted) void ensureLoaded();
    });
    return loading;
  }
  async function go(number: number) {
    if (isPDF) {
      page = Math.max(1, Math.min(count, number));
      await redraw(true);
    } else {
      const selected = imageFiles[Math.max(0, Math.min(imageFiles.length - 1, number - 1))];
      if (selected && selected !== file.path)
        await app.buffers.open(selected, false, { replaceActive: true });
    }
  }
  async function neighbor(direction: number) {
    if (isPDF) {
      await go(page + direction);
      return;
    }
    // Directory navigation replaces the image slot instead of retaining every decoded image.
    await refreshImages();
    if (current())
      await go(
        ((imageFiles.indexOf(file.path) + direction + imageFiles.length) % imageFiles.length) + 1,
      );
  }
  function endPicker() {
    ownsPicker = false;
    if (current()) viewport.focus();
  }
  function showPicker(
    title: string,
    choices: Parameters<PluginContext['picker']['show']>[1],
    selection = 0,
  ) {
    ownsPicker = true;
    app.picker.show(title, choices, endPicker, selection);
  }
  async function search(queryText: string) {
    if (!pdf) throw new Error('Text search is available for PDF documents.');
    const source = pdf,
      version = ++operationRevision;
    const valid = () =>
      current() && version === operationRevision && ownsPicker && app.picker.visible;
    query = queryText;
    hits = [];
    selectedHit = -1;
    showPicker('Searching PDF… · Esc cancels', []);
    let lastProgress = 0;
    try {
      hits = await source.search(query, valid, (number) => {
        if (valid() && Date.now() - lastProgress >= 100) {
          lastProgress = Date.now();
          showPicker('Searching PDF · ' + number + '/' + count + ' · Esc cancels', []);
        }
      });
    } catch (error) {
      if (valid()) throw error;
      else return;
    }
    if (!valid()) return;
    if (!hits.length) {
      showPicker('No PDF matches', []);
      await redraw();
      return;
    }
    showPicker(
      'PDF search · ' + hits.length + (hits.length === 200 ? '+ (limit)' : ' matches'),
      hits.map((hit, index) => ({
        label: hit.excerpt,
        detail: 'page ' + hit.page,
        async run() {
          if (!current()) return;
          selectedHit = index;
          await go(hit.page);
        },
      })),
    );
  }
  async function index() {
    if (!isPDF) {
      await refreshImages();
      if (!current()) return;
      showPicker(
        'Images in directory',
        imageFiles.map((path) => ({
          label: path.split('/').at(-1)!,
          run: () => app.buffers.open(path, false, { replaceActive: true }),
        })),
        imageFiles.indexOf(file.path),
      );
      return;
    }
    if (!pdf) return;
    const version = ++operationRevision;
    showPicker('PDF outline · Loading…', []);
    const valid = () =>
      current() && version === operationRevision && ownsPicker && app.picker.visible;
    let outline: Awaited<ReturnType<PDFReader['outline']>>;
    try {
      outline = await pdf.outline(valid);
    } catch (error) {
      if (valid()) throw error;
      else return;
    }
    if (!valid()) return;
    showPicker(
      outline.length ? 'PDF outline' : 'This PDF has no outline',
      outline.map((entry) => ({
        label: entry.title,
        display: '\u00a0\u00a0'.repeat(Math.min(12, entry.depth)) + entry.title,
        detail: 'page ' + entry.page,
        run: () => go(entry.page),
      })),
    );
  }
  async function run(action: Action) {
    if (!current()) return;
    if (action === 'reload') {
      if (loading) await loading;
      if (current()) await ensureLoaded();
      return;
    }
    if (loading) await loading;
    if (!current()) return;
    if (action === 'next' || action === 'previous') {
      neighborQueue = neighborQueue
        .catch(() => {})
        .then(() => (current() ? neighbor(action === 'next' ? 1 : -1) : undefined));
      await neighborQueue;
      return;
    }
    if (action === 'outline') {
      await index();
      return;
    }
    if (action === 'search' || action === 'goto') {
      ownsPicker = true;
      app.picker.prompt(
        action === 'search' ? 'Search PDF text' : 'Go to page or image',
        action === 'search' ? query : String(isPDF ? page : imageFiles.indexOf(file.path) + 1),
        async (value) => {
          if (!current()) return;
          if (action === 'search') await search(value);
          else {
            if (!/^\d+$/.test(value) || Number(value) < 1)
              throw new Error('Enter a positive page or image number.');
            await go(Number(value));
          }
        },
        endPicker,
      );
      return;
    }
    if (action === 'rotate') rotation = (rotation + 90) % 360;
    if (action === 'fit' || action === 'width' || action === 'actual') mode = action;
    if (action === 'zoom-in' || action === 'zoom-out') {
      mode = 'manual';
      scale = Math.max(
        0.02,
        Math.min(16, scale * (action === 'zoom-in' ? options().zoomStep : 1 / options().zoomStep)),
      );
    }
    await redraw();
  }
  function invoke(action: Action) {
    void run(action).catch((error) => {
      if (current() && error?.name !== 'AbortError') app.report(error);
    });
  }
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
    button.onclick = () => {
      invoke(button.dataset.action as Action);
      viewport.focus();
    };
  });
  viewport.onkeydown = (event) => {
    if (event.isComposing || event.metaKey || event.altKey) return;
    if (commandKeys.handle(event)) return;
    if (event.ctrlKey) {
      if (event.key === 'r') {
        event.preventDefault();
        if (isPDF) root.classList.toggle('media-recolored');
        else invoke('rotate');
      }
      if (['d', 'u', 'f', 'b'].includes(event.key)) {
        event.preventDefault();
        viewport.scrollBy(
          0,
          viewport.clientHeight *
            (['u', 'b'].includes(event.key) ? -1 : 1) *
            (['d', 'u'].includes(event.key) ? 0.5 : 0.9),
        );
      }
      return;
    }
    const key = event.key;
    if (/^[0-9]$/.test(key)) {
      digits = (digits + key).slice(-6);
      event.preventDefault();
      return;
    }
    const numbered = digits.length > 0;
    const amount = Math.max(1, Math.min(1000, Number(digits) || 1));
    digits = '';
    if (key === 'g') {
      event.preventDefault();
      if (previousG) {
        previousG = false;
        void go(1).catch(app.report);
      } else previousG = true;
      return;
    }
    previousG = false;
    let action: Action | undefined;
    if (key === 'G') {
      event.preventDefault();
      void go(numbered ? amount : isPDF ? count : imageFiles.length).catch(app.report);
      return;
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      void go(key === 'Home' ? 1 : isPDF ? count : imageFiles.length).catch(app.report);
      return;
    }
    if (key === 'q') {
      event.preventDefault();
      void app.buffers.close().catch(app.report);
      return;
    }
    if (key === 'Escape') {
      query = '';
      hits = [];
      selectedHit = -1;
      digits = '';
      commandKeys.cancel();
      void redraw();
      return;
    }
    if (
      'hjkl'.includes(key) ||
      (isPDF && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key))
    ) {
      const x =
        key === 'h' || key === 'ArrowLeft' ? -1 : key === 'l' || key === 'ArrowRight' ? 1 : 0;
      const y = key === 'k' || key === 'ArrowUp' ? -1 : key === 'j' || key === 'ArrowDown' ? 1 : 0;
      event.preventDefault();
      viewport.scrollBy(x * 50 * amount, y * 50 * amount);
      return;
    }
    if (['J', 'PageDown', ']'].includes(key) || (!isPDF && key === 'ArrowRight')) action = 'next';
    if (['K', 'PageUp', '['].includes(key) || (!isPDF && key === 'ArrowLeft')) action = 'previous';
    if (['+', 'i'].includes(key) || (!isPDF && key === 'ArrowUp')) action = 'zoom-in';
    if (['-', 'o'].includes(key) || (!isPDF && key === 'ArrowDown')) action = 'zoom-out';
    if (key === '=') action = 'actual';
    if (key === 'a') action = isPDF ? 'fit' : 'actual';
    if (key === 's') action = isPDF || mode === 'fit' ? 'width' : 'fit';
    if (key === 'w') action = 'width';
    if (key === 'r') {
      if (!isPDF) {
        rotation = 0;
        mode = 'fit';
      }
      action = isPDF ? 'rotate' : 'fit';
    }
    if (key === 'R') action = 'reload';
    if (key === 'Tab') action = 'outline';
    if (key === '/' && isPDF) action = 'search';
    if (key === ':') action = 'goto';
    if (key === 'c') {
      viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
    }
    if ((key === 'n' || key === 'N') && isPDF && hits.length) {
      event.preventDefault();
      selectedHit =
        selectedHit < 0
          ? key === 'N'
            ? hits.length - 1
            : 0
          : (selectedHit + (key === 'N' ? -1 : 1) + hits.length) % hits.length;
      void go(hits[selectedHit].page).catch(app.report);
      return;
    }
    if (action) {
      event.preventDefault();
      invoke(action);
    }
  };
  viewport.onwheel = (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      invoke(event.deltaY < 0 ? 'zoom-in' : 'zoom-out');
    }
  };
  let drag: { pointer: number; x: number; y: number; left: number; top: number } | undefined;
  viewport.onpointerdown = (event) => {
    if (event.button !== 1 && (isPDF || event.button !== 0)) return;
    event.preventDefault();
    viewport.focus();
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  };
  viewport.onpointerup = viewport.onpointercancel = () => {
    if (drag && viewport.hasPointerCapture(drag.pointer))
      viewport.releasePointerCapture(drag.pointer);
    drag = undefined;
  };
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (current() && !loading) void redraw();
    }, 60);
  });
  observer.observe(viewport);
  const unsubscribe = app.files.onEvent((event) => {
    if (event.type !== 'files') return;
    if (event.file === file.path) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (current()) invoke('reload');
        else {
          pdf?.destroy();
          pdf = undefined;
          image = undefined;
        }
      }, 120);
    }
  });
  const watching = app.files.watchResource(file.path, true);
  void watching.catch(app.report);
  const result: Controller = {
    run,
    focus() {
      if (!disposed) viewport.focus();
    },
    setActive(value) {
      active = value;
      if (!value) {
        commandKeys.cancel();
        operationRevision++;
        renderRevision++;
        pdf?.cancelRender();
        if (ownsPicker) {
          app.picker.close();
          ownsPicker = false;
        }
        clearPaper();
        // Pending loads have no visible consumer and must not attach a late result.
        if (loading) controller.abort();
      } else if (pdf || image) void redraw();
      else void ensureLoaded();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      active = false;
      generation++;
      operationRevision++;
      renderRevision++;
      controller.abort();
      pdf?.destroy();
      pdf = undefined;
      image?.removeAttribute('src');
      image = undefined;
      if (ownsPicker) app.picker.close();
      clearTimeout(resizeTimer);
      clearTimeout(reloadTimer);
      observer.disconnect();
      unsubscribe();
      commandKeys.destroy();
      clearPaper();
      root.remove();
      app.signal.removeEventListener('abort', result.destroy);
      instances.get(app)?.delete(file.path);
      void watching.then(() => app.files.watchResource(file.path, false)).catch(app.report);
    },
  };
  app.signal.addEventListener('abort', result.destroy, { once: true });
  status();
  return result;
}

export const mediaViewerPlugin: Plugin = {
  ...manifest,
  activate(app) {
    const views = new Map<string, Controller>();
    instances.set(app, views);
    app.onDispose(() => {
      for (const view of [...views.values()]) view.destroy();
      views.clear();
      instances.delete(app);
    });
    app.registerCommand('media.open', () => {
      app.picker.prompt('Open PDF or image', '', async (path) => {
        if (!app.signal.aborted) await app.buffers.open(path);
      });
    });
    for (const command of manifest.commands.filter((command) => command.id !== 'media.open'))
      app.registerCommand(command.id, async () => {
        const path = app.buffers.active()?.info?.path;
        const view = path ? views.get(path) : undefined;
        if (!view) throw new Error('Open a PDF or image buffer first.');
        await view.run(command.id.slice('media.'.length) as Action);
      });
  },
  createView(context) {
    const view = createMediaView(context);
    instances.get(context.app)!.set(context.file.path, view);
    return view;
  },
};
