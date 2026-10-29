// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { Repo } from '@automerge/automerge-repo';
import * as A from '@automerge/automerge';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import type { FileDoc } from '@portleaf/data-patchwork';
import { collaboration } from '../../src/collaboration.js';

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

test('UTF-16 transactions preserve emoji and remote changes survive local undo', () => {
  const repo = new Repo();
  const handle = repo.create<FileDoc>({
    '@patchwork': { type: 'file' },
    name: 'unicode.md',
    extension: 'md',
    mimeType: 'text/markdown',
    content: '🐾 hello 中文\n',
  });
  const view = new EditorView({
    parent: document.body,
    doc: handle.doc().content,
    extensions: [history(), collaboration(handle)],
  });
  views.push(view);
  view.dispatch({ changes: { from: 3, insert: 'local ' } });
  expect(handle.doc().content).toBe('🐾 local hello 中文\n');
  handle.change((doc) => A.splice(doc, ['content'], doc.content.length, 0, 'External\n'));
  expect(view.state.doc.toString()).toBe('🐾 local hello 中文\nExternal\n');
  undo(view);
  expect(handle.doc().content).toBe('🐾 hello 中文\nExternal\n');
  expect(view.state.doc.toString()).toBe(handle.doc().content);
});
