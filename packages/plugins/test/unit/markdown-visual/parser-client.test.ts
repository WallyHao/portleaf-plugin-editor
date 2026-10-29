import { afterEach, expect, test, vi } from 'vitest';
import { createMarkdownParser } from '../../../src/shared/markdown-parser-client.js';

afterEach(() => vi.unstubAllGlobals());
test('shares identical in-flight parses and rejects pending work when its owner is disposed', async () => {
  const messages: { id: number; source: string }[] = [];
  let worker: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    terminate = vi.fn();
    constructor() {
      worker = this;
    }
    postMessage(message: { id: number; source: string }) {
      messages.push(message);
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const parser = createMarkdownParser();
  const first = parser.parse('Same');
  expect(parser.parse('Same')).toBe(first);
  expect(messages).toHaveLength(1);
  const root = { type: 'root', children: [] };
  worker!.onmessage?.({ data: { id: messages[0].id, root } });
  expect(await first).toEqual(root);
  const second = parser.parse('Pending');
  const rejected = expect(second).rejects.toThrow('disabled');
  parser.destroy();
  await rejected;
  expect(worker!.terminate).toHaveBeenCalledTimes(1);
  await expect(parser.parse('Later')).rejects.toThrow('disabled');
});
