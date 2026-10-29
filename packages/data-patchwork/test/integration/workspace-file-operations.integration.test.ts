import { expect, test } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { Workspace, type FileDoc } from '../../src/index.js';
import { fixture, closeWorkspace, trackWorkspace } from '../fixture.js';
import path from 'node:path';
import * as A from '@automerge/automerge';

test('copies the current document with its encoding, a new identity, and no overwrites', async () => {
  const { root, workspace, handle } = await fixture('\ufeff# Note\r\n');
  handle.change((doc) => A.splice(doc, ['content'], 2, 0, 'Updated '));
  const copy = await workspace.copy('note.md', 'copy.md');
  expect(copy.url).not.toBe(handle.url);
  expect(await readFile(path.join(root, 'copy.md'), 'utf8')).toBe('\ufeff# Updated Note\r\n');
  await writeFile(path.join(root, 'mixed.md'), '# Mixed\r\nText\n');
  const mixed = await workspace.copy('mixed.md', 'mixed-copy.md');
  expect(mixed.readOnly).toBe(true);
  expect(await readFile(path.join(root, 'mixed-copy.md'), 'utf8')).toBe('# Mixed\r\nText\n');
  await expect(workspace.copy('note.md', 'copy.md')).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(workspace.copy('note.md', '../outside.md')).rejects.toThrow('inside');
  expect(await readFile(path.join(root, 'copy.md'), 'utf8')).toBe('\ufeff# Updated Note\r\n');
});

test('recovers a detached document through copy without recreating its original file', async () => {
  const { root, file, workspace, handle } = await fixture('Keep this note.\n');
  await rm(file);
  await workspace.flush();
  expect((await workspace.browse('.')).find((entry) => entry.name === 'note.md')?.deleted).toBe(
    true,
  );
  const copy = await workspace.copy('note.md', 'recovered.md');
  expect(copy.url).not.toBe(handle.url);
  expect(await readFile(path.join(root, 'recovered.md'), 'utf8')).toBe('Keep this note.\n');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('preserves a stable document ID across rename and restart', async () => {
  const { directory, root, workspace, handle } = await fixture();
  await workspace.rename('note.md', 'renamed.md');
  expect((await workspace.open('renamed.md')).url).toBe(handle.url);
  await closeWorkspace(workspace);
  await writeFile(path.join(root, 'renamed.md'), '# Edited while closed\n');
  const reopened = await Workspace.load(root, path.join(directory, 'state'));
  trackWorkspace(reopened);
  const info = await reopened.open('renamed.md');
  expect(info.url).toBe(handle.url);
  expect((await reopened.repo.find<FileDoc>(info.url)).doc().content).toBe(
    '# Edited while closed\n',
  );
});

test('text files preserve encoding, merge external updates, retain history, and keep identity after rename and restart', async () => {
  const { root, directory, workspace } = await fixture();
  const original = '\ufeffconst label = "中文";\r\n// footer\r\n';
  const file = path.join(root, 'code.ts');
  await writeFile(file, original);
  const info = await workspace.open('code.ts');
  const handle = await workspace.repo.find<FileDoc>(info.url);
  expect(handle.doc().mimeType).toBe('text/plain');
  await workspace.flush();
  expect(await readFile(file, 'utf8')).toBe(original);
  handle.change((doc) => A.splice(doc, ['content'], 0, 0, '// local\n'));
  await writeFile(file, original.replace('// footer', '// external'));
  await workspace.flush();
  expect(await readFile(file, 'utf8')).toBe(
    '\ufeff// local\r\nconst label = "中文";\r\n// external\r\n',
  );
  const copy = await workspace.copy('code.ts', 'copy.txt');
  expect(copy.url).not.toBe(info.url);
  await workspace.rename('code.ts', 'Makefile');
  await closeWorkspace(workspace);
  const reopened = await Workspace.load(root, path.join(directory, 'state'));
  trackWorkspace(reopened);
  expect((await reopened.open('Makefile')).url).toBe(info.url);
  expect(
    (await reopened.history('Makefile')).some((version) => version.text.includes('// local')),
  ).toBe(true);
  expect(await reopened.list()).toEqual(['note.md']);
  expect(await reopened.list('.', { text: true })).toEqual(['copy.txt', 'Makefile', 'note.md']);
});
