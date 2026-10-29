import { EditorView } from '@codemirror/view';
import type { Nodes, Root } from 'mdast';
import { focusBuffer, type Buffer, type Plugin } from '@portleaf/core';
import type { Text } from '@codemirror/state';
import { createMarkdownParser } from '../shared/markdown-parser-client.js';
import { isMarkdownFile } from '../shared/file-types.js';
import { manifest } from './manifest.js';

const headingText = (node: Nodes): string =>
  'value' in node
    ? node.value
    : 'alt' in node
      ? (node.alt ?? '')
      : 'children' in node
        ? node.children.map(headingText).join('')
        : '';

export function outlineHeadings(root: Root) {
  const headings: { title: string; depth: number; from: number; line: number }[] = [];
  function visit(node: Nodes) {
    if (node.type === 'heading' && node.position?.start.offset !== undefined)
      headings.push({
        title: headingText(node).replace(/\s+/g, ' ').trim() || '(untitled)',
        depth: node.depth,
        from: node.position.start.offset,
        line: node.position.start.line,
      });
    if ('children' in node) node.children.forEach(visit);
  }
  visit(root);
  return headings;
}

export const outlinePlugin: Plugin = {
  ...manifest,
  activate(context) {
    const parser = createMarkdownParser();
    let revision = 0;
    let shown: { buffer: Buffer; doc: Text } | undefined;
    context.onDispose(() => {
      revision++;
      shown = undefined;
      parser.destroy();
    });
    context.onDispose(
      context.buffers.subscribe(() => {
        if (
          shown &&
          (context.buffers.active() !== shown.buffer || shown.buffer.view?.state.doc !== shown.doc)
        )
          context.picker.close();
      }),
    );
    context.registerCommand('outline.open', async () => {
      const buffer = context.buffers.active();
      if (!buffer?.info || !buffer.view || !isMarkdownFile(buffer.info.path))
        throw new Error('The document outline is available for Markdown files.');
      const view = buffer.view;
      if (view.composing) return;
      const version = ++revision;
      const doc = view.state.doc;
      const close = () => {
        shown = undefined;
        focusBuffer(context.buffers.active());
      };
      shown = { buffer, doc };
      context.picker.show('Document outline · Loading…', [], close);
      let root: Root;
      try {
        root = await parser.parse(doc.toString());
      } catch (error) {
        if (context.signal.aborted) return;
        if (version === revision) context.picker.close();
        throw error;
      }
      if (
        context.signal.aborted ||
        version !== revision ||
        !context.picker.visible ||
        context.buffers.active() !== buffer ||
        view.state.doc !== doc
      )
        return;
      const headings = outlineHeadings(root);
      const cursor = view.state.selection.main.head;
      let current = 0;
      headings.forEach((heading, index) => {
        if (heading.from <= cursor) current = index;
      });
      context.picker.show(
        'Document outline',
        headings.map((heading, index) => ({
          label: heading.title,
          display: '\u00a0\u00a0'.repeat(heading.depth - 1) + heading.title,
          detail: `${index === current ? '› ' : ''}H${heading.depth} · line ${heading.line}`,
          run() {
            if (
              context.signal.aborted ||
              context.buffers.active() !== buffer ||
              view.state.doc !== doc
            )
              return;
            view.dispatch({
              selection: { anchor: heading.from },
              effects: EditorView.scrollIntoView(heading.from, { y: 'center' }),
            });
            view.focus();
          },
        })),
        close,
        current,
      );
    });
  },
};
