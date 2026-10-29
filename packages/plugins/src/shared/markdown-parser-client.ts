import type { Root } from 'mdast';

export type MarkdownParser = { parse(source: string): Promise<Root>; destroy(): void };

export function createMarkdownParser(): MarkdownParser {
  let worker: Worker | undefined;
  let sequence = 0,
    disposed = false;
  const pending = new Map<number, { resolve(root: Root): void; reject(error: Error): void }>();
  const requests = new Map<string, Promise<Root>>();
  function fail(error: Error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = undefined;
  }
  return {
    parse(source) {
      if (disposed) return Promise.reject(new Error('Markdown parser is disabled.'));
      const existing = requests.get(source);
      if (existing) return existing;
      const request = new Promise<Root>((resolve, reject) => {
        // Non-browser test environments use the same parser without creating a worker.
        if (typeof Worker === 'undefined') {
          void import('./markdown-parser.js')
            .then((parser) => parser.parseMarkdown(source))
            .then(resolve, reject);
          return;
        }
        if (!worker) {
          worker = new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), {
            type: 'module',
          });
          worker.onmessage = (event: MessageEvent<{ id: number; root: Root; error?: string }>) => {
            const request = pending.get(event.data.id);
            if (!request) return;
            pending.delete(event.data.id);
            if (event.data.error !== undefined) request.reject(new Error(event.data.error));
            else request.resolve(event.data.root);
          };
          worker.onerror = (event) => fail(new Error(event.message || 'Markdown parser failed.'));
        }
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, source });
      }).finally(() => requests.delete(source));
      requests.set(source, request);
      return request;
    },
    destroy() {
      disposed = true;
      fail(new Error('Markdown parser is disabled.'));
      requests.clear();
    },
  };
}
