import {
  getDocument,
  PDFWorker,
  PDFDataRangeTransport,
  TextLayer,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
  type RenderTask,
} from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { textMatches, rasterScale } from './model.js';

export type SearchHit = { page: number; offset: number; excerpt: string };
export type PDFReader = Awaited<ReturnType<typeof openPDF>>;

export async function openPDF(url: string, signal: AbortSignal, length: number) {
  if (signal.aborted) throw new DOMException('Viewer closed', 'AbortError');
  const worker = new Worker(workerURL, { type: 'module' });
  const pdfWorker = PDFWorker.create({ port: worker });
  // The page is dist/index.html; assets are copied beside it by the build.
  const assetRoot = new URL('pdfjs/', window.location.href).href;
  let task: PDFDocumentLoadingTask | undefined;
  let renderTask: RenderTask | undefined;
  let textLayer: TextLayer | undefined;
  let revision = 0;
  let destroyed = false;
  const network = new AbortController();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});
  const request = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, failure]);
  worker.onerror = (event) => {
    rejectFailure(new Error(event.message || 'PDF worker failed.'));
    destroy();
  };
  let serial: Promise<unknown> = Promise.resolve();
  const cancelRender = () => {
    revision++;
    renderTask?.cancel();
    textLayer?.cancel();
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    rejectFailure(new DOMException('PDF viewer closed', 'AbortError'));
    network.abort();
    cancelRender();
    signal.removeEventListener('abort', destroy);
    // terminate the native Worker even when PDF loading or rendering failed.
    void task?.destroy().catch(() => {});
    pdfWorker.destroy();
    worker.terminate();
  };
  signal.addEventListener('abort', destroy, { once: true });
  let document: PDFDocumentProxy;
  try {
    // PDF.js's built-in HTTP loader treats custom-scheme XHR status 0 as failure.
    // Use its public range transport with Electron's validated resource endpoint.
    const first = await fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: network.signal });
    if (!first.ok) throw new Error('Cannot read PDF (' + first.status + ').');
    const initial = new Uint8Array(await first.arrayBuffer());
    class ResourceTransport extends PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        void fetch(url, {
          headers: { Range: 'bytes=' + begin + '-' + (end - 1) },
          signal: network.signal,
        })
          .then(async (response) => {
            if (response.status !== 206)
              throw new Error('PDF range read failed (' + response.status + ').');
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length !== end - begin)
              throw new Error('PDF changed while reading. Press R to reload.');
            if (!destroyed) this.onDataRange(begin, bytes);
          })
          .catch((error) => {
            if (!destroyed) rejectFailure(error);
          });
      }
      abort() {
        network.abort();
      }
    }
    const source =
      first.status === 206 && initial.length < length
        ? { range: new ResourceTransport(length, initial), length, rangeChunkSize: 65536 }
        : { data: initial };
    task = getDocument({
      ...source,
      worker: pdfWorker,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: assetRoot + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assetRoot + 'standard_fonts/',
      wasmUrl: assetRoot + 'wasm/',
      iccUrl: assetRoot + 'iccs/',
      useWorkerFetch: true,
    });
    document = await request(task.promise);
    if (signal.aborted) throw new DOMException('Viewer closed', 'AbortError');
  } catch (error) {
    destroy();
    throw error;
  }
  return {
    pages: document.numPages,
    async size(number: number, rotation: number) {
      const page = await request(document.getPage(number));
      const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      return { width: viewport.width, height: viewport.height };
    },
    render(
      number: number,
      rotation: number,
      scale: number,
      budget: number,
      container: HTMLElement,
      query: string,
      selectedOffset?: number,
    ) {
      cancelRender();
      const version = revision;
      const operation = serial
        .catch(() => {})
        .then(async () => {
          if (destroyed || version !== revision) return false;
          const page = await request(document.getPage(number));
          if (destroyed || version !== revision) return false;
          const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
          const ratio = rasterScale(
            viewport.width,
            viewport.height,
            window.devicePixelRatio || 1,
            budget,
          );
          const canvas = window.document.createElement('canvas');
          canvas.className = 'media-pdf-canvas';
          canvas.setAttribute('aria-label', 'PDF page ' + number);
          canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
          canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
          canvas.style.width = viewport.width + 'px';
          canvas.style.height = viewport.height + 'px';
          container.style.width = viewport.width + 'px';
          container.style.height = viewport.height + 'px';
          container.style.setProperty('--total-scale-factor', String(scale));
          container.append(canvas);
          renderTask = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
          try {
            await request(renderTask.promise);
            if (destroyed || version !== revision) return false;
            const content = await request(page.getTextContent());
            if (destroyed || version !== revision) return false;
            const layer = window.document.createElement('div');
            layer.className = 'media-text-layer';
            container.append(layer);
            textLayer = new TextLayer({ textContentSource: content, container: layer, viewport });
            await textLayer.render();
            let position = 0;
            const strings = textLayer.textContentItemsStr;
            const offsets = textMatches(strings.join(' '), query);
            textLayer.textDivs.forEach((span, index) => {
              const value = strings[index];
              const end = position + value.length;
              const fragment = window.document.createDocumentFragment();
              let cursor = 0;
              for (const offset of offsets) {
                if (offset >= end || offset + query.length <= position) continue;
                const from = Math.max(0, offset - position),
                  to = Math.min(value.length, offset + query.length - position);
                fragment.append(value.slice(cursor, from));
                const mark = window.document.createElement('mark');
                mark.className = offset === selectedOffset ? 'media-match selected' : 'media-match';
                mark.textContent = value.slice(from, to);
                fragment.append(mark);
                cursor = to;
              }
              if (cursor) {
                fragment.append(value.slice(cursor));
                span.replaceChildren(fragment);
              }
              position = end + 1;
            });
            return !destroyed && version === revision;
          } catch (error) {
            if (destroyed || version !== revision) return false;
            throw error;
          } finally {
            renderTask = undefined;
            textLayer = undefined;
          }
        });
      serial = operation;
      return operation;
    },
    async search(query: string, current: () => boolean, progress: (page: number) => void) {
      const hits: SearchHit[] = [];
      for (let number = 1; number <= document.numPages && hits.length < 200; number++) {
        if (destroyed || !current()) return hits;
        progress(number);
        const page = await request(document.getPage(number));
        const content = await request(page.getTextContent());
        const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
        for (const offset of textMatches(text, query, 200 - hits.length))
          hits.push({
            page: number,
            offset,
            excerpt: text.slice(Math.max(0, offset - 30), offset + query.length + 50),
          });
        // Rendered pages own their graphics; scanned pages need no retained graphics.
        if (!renderTask) page.cleanup();
      }
      return hits;
    },
    async outline(current: () => boolean) {
      const result: { title: string; page: number; depth: number }[] = [];
      const items = await request(document.getOutline());
      async function walk(nodes: NonNullable<typeof items>, depth: number) {
        for (const node of nodes) {
          if (destroyed || !current() || result.length >= 1000) return;
          const dest =
            typeof node.dest === 'string'
              ? await request(document.getDestination(node.dest))
              : node.dest;
          if (Array.isArray(dest) && dest.length) {
            const index =
              typeof dest[0] === 'number' ? dest[0] : await request(document.getPageIndex(dest[0]));
            result.push({ title: node.title, page: index + 1, depth });
          }
          if (node.items.length) await walk(node.items, depth + 1);
        }
      }
      await walk(items ?? [], 0);
      return result;
    },
    cancelRender,
    destroy,
  };
}
