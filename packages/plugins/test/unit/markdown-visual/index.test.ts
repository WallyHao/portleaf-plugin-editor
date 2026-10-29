// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { parseMarkdown } from '../../../src/shared/markdown-parser.js';
import type { Root } from 'mdast';
import type { BufferContext } from '@portleaf/core';
import { markdownHtmlPlugin } from '../../../src/markdown-html/index.js';
import {
  markdownPresentation,
  ensureParsed,
  type MarkdownContext,
  isMarkdownLive,
  toggleMarkdownView,
  safeMarkdownTarget,
  toggleMarkdownTask,
} from '../../../src/markdown-visual/index.js';

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});
const context: MarkdownContext = {
  resource: (target) => (target.startsWith('data:') ? target : undefined),
  settings: {
    plugins: ['markdown', 'markdown-visual'],
    theme: 'minimal',
    fontFamily: 'monospace',
    fontSize: 18,
    themeData: { dark: true, colors: {} },
    markdownMode: 'live',
  },
};

test('renders README-style HTML safely and exposes its source when selected', async () => {
  const source =
    '<div align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><img src="header.svg" alt="Header"></picture><script>bad()</script><a href="#heading">Heading</a></div>\n\nTail';
  const openLink = vi.fn();
  const view = new EditorView({
    parent: document.body,
    doc: source,
    selection: { anchor: source.length },
    extensions: [
      markdownPresentation({ ...context, resource: (target) => `/images/${target}`, openLink }),
      markdownHtmlPlugin.extension!({ buffer: { info: { path: 'README.md' } } } as BufferContext),
    ],
  });
  views.push(view);
  await ensureParsed(view);
  expect(view.dom.querySelector('.md-html div')?.getAttribute('style')).toContain('center');
  expect(view.dom.querySelector('.md-html img')?.getAttribute('src')).toBe('/images/header.svg');
  expect(view.dom.querySelector('.md-html source')?.getAttribute('srcset')).toBe(
    '/images/dark.svg',
  );
  expect(view.dom.querySelector('.md-html script')).toBeNull();
  view.dispatch({ selection: { anchor: 1 } });
  expect(view.dom.querySelector('.md-html')).toBeNull();
  expect(view.state.doc.toString()).toBe(source);
});
async function editor(doc: string, readOnly = false) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [history(), EditorState.readOnly.of(readOnly), markdownPresentation(context)],
    }),
  });
  views.push(view);
  await ensureParsed(view);
  return view;
}

test('renders Markdown while keeping source, selection, and undo history through view switches', async () => {
  const source = '# Heading\n\n**Bold** and *italic*, ~~removed~~, `code`.\n\n';
  const view = await editor(source);
  expect(view.dom.querySelector('.md-strong')?.textContent).toBe('Bold');
  expect(view.dom.querySelector('.md-emphasis')?.textContent).toBe('italic');
  expect(view.dom.querySelector('.md-delete')?.textContent).toBe('removed');
  expect(view.dom.querySelector('.md-inlineCode')?.textContent).toBe('code');
  expect(view.dom.textContent).not.toContain('**');
  const anchor = view.state.selection.main.head;
  toggleMarkdownView(view);
  expect(isMarkdownLive(view.state)).toBe(false);
  expect(view.dom.textContent).toContain('**Bold**');
  expect(view.state.selection.main.head).toBe(anchor);
  view.dispatch({ changes: { from: view.state.doc.length, insert: 'Typed' } });
  toggleMarkdownView(view);
  undo(view);
  expect(view.state.doc.toString()).toBe(source);
});

test('shows source when the caret enters a rendered formula or table', async () => {
  const source =
    'Equation: $x^2$.\n\n| Item | Value |\n| --- | --- |\n| A | **B** |\n\n$$\nx = 2\n$$\n\n';
  const view = await editor(source);
  await expect.poll(() => view.dom.querySelectorAll('.md-math math').length).toBe(2);
  expect(view.dom.querySelector('table strong')?.textContent).toBe('B');
  view.dispatch({ selection: { anchor: source.indexOf('x^2') } });
  expect(view.dom.textContent).toContain('$x^2$');
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ selection: { anchor: source.indexOf('| A') } });
  expect(view.dom.querySelector('table')).toBeNull();
  expect(view.dom.textContent).toContain('| A | **B** |');
});

test('task widgets edit the actual Markdown and honor read-only buffers', async () => {
  const source = '- [ ] Task\n\n';
  const view = await editor(source);
  (view.dom.querySelector('button[role="checkbox"]') as HTMLButtonElement).click();
  expect(view.state.doc.toString()).toBe('- [x] Task\n\n');
  undo(view);
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ selection: { anchor: source.indexOf('Task') } });
  expect(await toggleMarkdownTask(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('- [x] Task\n\n');
  const locked = await editor(source, true);
  locked.dispatch({ selection: { anchor: source.indexOf('Task') } });
  expect(await toggleMarkdownTask(locked)).toBe(false);
  locked.dispatch({ selection: { anchor: source.length } });
  await ensureParsed(locked);
  (locked.dom.querySelector('button[role="checkbox"]') as HTMLButtonElement).click();
  expect(locked.state.doc.toString()).toBe(source);
});

test('does not interpret code, front matter, raw HTML, or dangerous URLs as executable content', async () => {
  const source =
    '---\nname: **metadata**\n---\n\n```md\n**raw** $x$\n```\n\n<script>window.bad = true</script>\n\n[bad](javascript:alert(1))\n\n';
  const view = await editor(source);
  expect(view.dom.querySelector('.md-code code')?.textContent).toBe('**raw** $x$');
  expect(view.dom.querySelector('.md-math')).toBeNull();
  expect(view.dom.querySelector('script')).toBeNull();
  expect(view.dom.querySelector('[data-md-link]')).toBeNull();
  expect(view.dom.textContent).toContain('name: **metadata**');
  expect(safeMarkdownTarget('java\nscript:alert(1)')).toBeUndefined();
  expect(safeMarkdownTarget('https://example.com')).toBe('https://example.com');
  expect(view.state.doc.toString()).toBe(source);
});

test('source editing avoids parsing and unchanged rendered blocks survive edits elsewhere', async () => {
  const parse = vi.fn(async (source: string) => parseMarkdown(source));
  const source = '```ts\nconst value = 1;\n```\n\nTail\n\n';
  const view = new EditorView({
    parent: document.body,
    doc: source,
    selection: { anchor: source.length },
    extensions: markdownPresentation({
      ...context,
      settings: { ...context.settings, markdownMode: 'source' },
      parser: { parse, destroy() {} },
    }),
  });
  views.push(view);
  view.dispatch({ changes: { from: source.length, insert: 'One' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(parse).not.toHaveBeenCalled();
  toggleMarkdownView(view);
  await ensureParsed(view);
  const block = view.dom.querySelector('.md-code');
  expect(block).not.toBeNull();
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' Two' } });
  await ensureParsed(view);
  expect(view.dom.querySelector('.md-code')).toBe(block);
});

test('ignores stale parse results and retains the latest source and presentation', async () => {
  const pending = new Map<string, (root: Root) => void>();
  const old = '**Old**\n\nTail\n\n',
    next = '**New**\n\nTail\n\n';
  const view = new EditorView({
    parent: document.body,
    doc: old,
    selection: { anchor: old.length },
    extensions: markdownPresentation({
      ...context,
      parser: {
        parse: (source) => new Promise((resolve) => pending.set(source, resolve)),
        destroy() {},
      },
    }),
  });
  views.push(view);
  const first = ensureParsed(view, false);
  view.dispatch({ changes: { from: 0, to: old.length, insert: next } });
  const second = ensureParsed(view, false);
  pending.get(next)!(parseMarkdown(next));
  await second;
  pending.get(old)!(parseMarkdown(old));
  expect(await first).toBe(false);
  expect(view.state.doc.toString()).toBe(next);
  expect(view.dom.querySelector('.md-strong')?.textContent).toBe('New');
});

test('mapped task widgets use their current document position before reparsing', async () => {
  const source = '- [ ] Task\n\nTail\n\n';
  const view = await editor(source);
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n\n' } });
  const checkbox = view.dom.querySelector<HTMLButtonElement>('button[role="checkbox"]');
  expect(checkbox).not.toBeNull();
  checkbox!.click();
  expect(view.state.doc.toString()).toBe('Prefix\n\n- [x] Task\n\nTail\n\n');
  undo(view);
  expect(view.state.doc.toString()).toBe('Prefix\n\n' + source);
});
