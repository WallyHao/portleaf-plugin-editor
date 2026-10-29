// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { PluginHost, minimalPalette, type Buffer, type DesktopAPI } from '@portleaf/core';
import { outlinePlugin, outlineHeadings } from '../../../src/outline/index.js';
import { parseMarkdown } from '../../../src/shared/markdown-parser.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function fixture(source: string, file = 'note.md') {
  Element.prototype.scrollIntoView = vi.fn();
  const root = document.createElement('main');
  document.body.append(root);
  const listeners = new Set<() => void>();
  let view: EditorView;
  const buffer: Buffer = {
    info: { path: file, url: '', deleted: false, readOnly: false },
    get view() {
      return view;
    },
    resource: () => undefined,
    setMode() {},
  };
  const host = new PluginHost(
    [
      outlinePlugin,
      { id: 'test-theme', apiVersion: 1, theme: { name: 'test', palette: () => minimalPalette } },
    ],
    {
      root,
      status: root,
      files: {} as DesktopAPI,
      report: vi.fn(),
      quit: async () => {},
      setTheme: async () => {},
      buffers: {
        active: () => buffer,
        list: () => [buffer],
        open: async () => {},
        activate() {},
        close: async () => {},
        rename: async (_file, target) => target,
        flush: async () => {},
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  );
  host.configure({
    plugins: ['outline'],
    theme: 'test',
    fontFamily: 'monospace',
    fontSize: 18,
    themeData: minimalPalette,
    markdownMode: 'source',
  });
  const binding = host.createBuffer(buffer);
  view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        binding.extension,
        EditorView.updateListener.of(() => {
          for (const listener of listeners) listener();
        }),
      ],
    }),
  });
  binding.attach(view);
  cleanups.push(() => {
    binding.destroy();
    view.destroy();
    host.destroy();
  });
  return { host, view, root };
}

test('extracts ATX and Setext headings, inline text, nesting, and Unicode without treating code or front matter as headings', () => {
  const source =
    '---\ntitle: Header\n---\n\n# **中文** and `code`\n\n```md\n# Not a heading\n```\n\nSecond\n------\n\n> ### [Linked](target.md) ![picture](x.png)\n';
  expect(outlineHeadings(parseMarkdown(source))).toEqual([
    { title: '中文 and code', depth: 1, from: source.indexOf('# **'), line: 5 },
    { title: 'Second', depth: 2, from: source.indexOf('Second'), line: 11 },
    { title: 'Linked picture', depth: 3, from: source.indexOf('###'), line: 14 },
  ]);
});

test('opens at the current heading beyond 200 entries and jumps without changing the document', async () => {
  const source = Array.from({ length: 225 }, (_, index) => `## Heading ${index}\n\nText\n\n`).join(
    '',
  );
  const { host, view, root } = fixture(source);
  await host.execute('outline.open');
  expect(root.querySelector('[aria-selected="true"]')?.textContent).toContain('Heading 224');
  const list = root.querySelector<HTMLElement>('.quick-list')!;
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => expect(view.state.selection.main.head).toBe(0));
  expect(view.state.doc.toString()).toBe(source);
});

test('closes a stale outline after document changes and disposes its panel when disabled', async () => {
  const { host, view, root } = fixture('# Original\n\n## Child\n');
  await host.execute('outline.open');
  expect(root.querySelector<HTMLElement>('.picker')!.hidden).toBe(false);
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n' } });
  expect(root.querySelector<HTMLElement>('.picker')!.hidden).toBe(true);
  await host.execute('outline.open');
  host.configure({ ...host.settings, plugins: [] });
  expect(root.querySelector<HTMLElement>('.picker')!.hidden).toBe(true);
  expect(host.commandList).toEqual([]);
});

test('refuses a Markdown outline for a plain text file', async () => {
  const { host } = fixture('# Literal text\n', 'code.ts');
  await expect(host.execute('outline.open')).rejects.toThrow('Markdown files');
});

test('canceling a pending parse prevents the outline from reopening on a late worker result', async () => {
  let complete: () => void;
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      terminate() {}
      postMessage({ id, source }: { id: number; source: string }) {
        complete = () =>
          this.onmessage?.({ data: { id, root: parseMarkdown(source) } } as MessageEvent);
      }
    },
  );
  const { host, root } = fixture('# Heading\n');
  const pending = host.execute('outline.open');
  const panel = root.querySelector<HTMLElement>('.picker')!;
  expect(panel.hidden).toBe(false);
  root
    .querySelector<HTMLElement>('.quick-list')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(panel.hidden).toBe(true);
  complete!();
  await pending;
  expect(panel.hidden).toBe(true);
});
