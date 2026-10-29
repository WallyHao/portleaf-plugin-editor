// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LanguageDescription, ensureSyntaxTree } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { history, undo } from '@codemirror/commands';
import type { OpenFile } from '@portleaf/core';
import {
  chooseFileLanguage,
  fileHighlighting,
  fileLanguage,
} from '../../../src/text-files/highlighting.js';
import { detectFileLanguage, fileLanguages } from '../../../src/text-files/languages.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});
function editor(path: string, doc: string, catalog = fileLanguages) {
  const buffer: { info: OpenFile } = { info: { path, url: '', deleted: false, readOnly: false } };
  const slot = new Compartment();
  const report = vi.fn();
  const syntax = () => fileHighlighting(buffer, report, catalog);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [history(), slot.of(syntax())],
    }),
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      view.destroy();
    }
  };
  cleanups.push(close);
  return {
    view,
    report,
    close,
    refresh(path: string) {
      buffer.info.path = path;
      view.dispatch({ effects: slot.reconfigure(syntax()) });
    },
  };
}
const ready = (view: EditorView, name: string) =>
  vi.waitFor(() => expect(view.state.field(fileLanguage).name).toBe(name));
function tokens(view: EditorView) {
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100);
  const values: { text: string; classes: string }[] = [];
  if (!tree) return values;
  highlightTree(tree, classHighlighter, (from, to, classes) =>
    values.push({ text: view.state.sliceDoc(from, to), classes }),
  );
  return values;
}

test('matches language metadata, configuration filenames, uppercase extensions, and safe shebang hints', () => {
  for (const [file, firstLine, name] of [
    ['src/example.ts', '', 'TypeScript'],
    ['component.tsx', '', 'TSX'],
    ['app.PY', '', 'Python'],
    ['module.nix', '', 'Nix'],
    ['style.css', '', 'CSS'],
    ['document.html', '', 'HTML'],
    ['config.yaml', '', 'YAML'],
    ['Cargo.toml', '', 'TOML'],
    ['main.rs', '', 'Rust'],
    ['main.go', '', 'Go'],
    ['main.cpp', '', 'C++'],
    ['query.sql', '', 'SQL'],
    ['deploy/Dockerfile', '', 'Dockerfile'],
    ['Containerfile.dev', '', 'Dockerfile'],
    ['flake.lock', '', 'JSON'],
    ['Cargo.lock', '', 'TOML'],
    ['.zshrc', '', 'Shell'],
    ['.env.local', '', 'Shell'],
    ['script.zsh', '', 'Shell'],
    ['run', '#!/usr/bin/env -S python3 -u', 'Python'],
    ['run', '#!/bin/bash', 'Shell'],
    ['run', '#!/usr/bin/env NODE_ENV=test node', 'JavaScript'],
    ['run', '#!/usr/bin/python3.12', 'Python'],
    ['app.ts', '#!/bin/bash', 'TypeScript'],
  ])
    expect(detectFileLanguage(file, firstLine)?.name).toBe(name);
  expect(detectFileLanguage('notes.txt', 'Normal prose')).toBeNull();
  expect(detectFileLanguage('unknown.file', '#!/usr/bin/unknown')).toBeNull();
});

test.each([
  ['code.ts', 'const greeting: string = "中文";\n', 'TypeScript', 'const', 'tok-keyword'],
  ['code.py', 'def greet():\n    return "中文"\n', 'Python', 'def', 'tok-keyword'],
  ['flake.nix', 'let value = "中文"; in value\n', 'Nix', 'let', 'tok-keyword'],
  ['script.sh', 'if true; then echo "中文"; fi\n', 'Shell', 'if', 'tok-keyword'],
  ['data.json', '{"answer": 42, "ready": true}\n', 'JSON', '42', 'tok-number'],
])(
  'loads the actual %s grammar and highlights tokens without editing the source',
  async (path, source, name, token, tag) => {
    const { view, report } = editor(path, source);
    await ready(view, name);
    expect(tokens(view).some((value) => value.text === token && value.classes.includes(tag))).toBe(
      true,
    );
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main.head).toBe(source.length);
    expect(report).not.toHaveBeenCalled();
  },
);

test('language overrides survive reconfiguration, automatic mode follows rename, and language changes stay outside undo', async () => {
  const { view, refresh } = editor('code.ts', 'const value = 1;\n');
  await ready(view, 'TypeScript');
  view.dispatch({ changes: { from: 0, insert: '// edited\n' } });
  view.dispatch({ effects: chooseFileLanguage.of('Python') });
  await ready(view, 'Python');
  refresh('renamed.txt');
  await ready(view, 'Python');
  expect(view.state.field(fileLanguage).choice).toBe('Python');
  view.dispatch({ effects: chooseFileLanguage.of('auto') });
  await ready(view, 'Plain text');
  expect(tokens(view)).toEqual([]);
  refresh('renamed.py');
  await ready(view, 'Python');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('const value = 1;\n');
  expect(view.state.field(fileLanguage).choice).toBe('auto');
});

test('extensionless script highlighting follows external shebang edits and can be forced to plain text', async () => {
  const { view } = editor('run', '#!/usr/bin/env python3\nprint("hello")\n');
  await ready(view, 'Python');
  view.dispatch({ changes: { from: 0, to: view.state.doc.line(1).to, insert: '#!/bin/bash' } });
  await ready(view, 'Shell');
  view.dispatch({ effects: chooseFileLanguage.of('plain') });
  await ready(view, 'Plain text');
  expect(tokens(view)).toEqual([]);
});

test('ignores delayed grammar loads after a language switch or buffer disposal', async () => {
  const support = await fileLanguages.find((language) => language.name === 'Python')!.load();
  let finish!: (value: typeof support) => void;
  const delayed = LanguageDescription.of({
    name: 'Delayed',
    extensions: ['slow'],
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = editor('code.slow', '# source\n', [delayed]);
  first.view.dispatch({ effects: chooseFileLanguage.of('plain') });
  await ready(first.view, 'Plain text');
  finish(support);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.view.state.field(fileLanguage).name).toBe('Plain text');
  expect(tokens(first.view)).toEqual([]);
  let finishClosed!: (value: typeof support) => void;
  const closed = editor('code.slow', 'Keep source\n', [
    LanguageDescription.of({
      name: 'Closed',
      extensions: ['slow'],
      load: () =>
        new Promise((resolve) => {
          finishClosed = resolve;
        }),
    }),
  ]);
  const dispatch = vi.spyOn(closed.view, 'dispatch');
  closed.close();
  finishClosed(support);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(dispatch).not.toHaveBeenCalled();
  expect(closed.report).not.toHaveBeenCalled();
});

test('reports a failed grammar load once, keeps the file editable, and permits an explicit retry', async () => {
  const support = await fileLanguages.find((language) => language.name === 'Python')!.load();
  let attempts = 0;
  const retry = LanguageDescription.of({
    name: 'Retry',
    extensions: ['retry'],
    load: () =>
      ++attempts === 1 ? Promise.reject(new Error('Unavailable')) : Promise.resolve(support),
  });
  const { view, report } = editor('code.retry', 'Original\n', [retry]);
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  expect(attempts).toBe(1);
  expect(view.state.field(fileLanguage).name).toBe('Plain text');
  view.dispatch({ effects: chooseFileLanguage.of('auto') });
  await ready(view, 'Retry');
  expect(attempts).toBe(2);
  view.dispatch({ changes: { from: 0, insert: 'Typed ' } });
  expect(view.state.doc.toString()).toBe('Typed Original\n');
});
