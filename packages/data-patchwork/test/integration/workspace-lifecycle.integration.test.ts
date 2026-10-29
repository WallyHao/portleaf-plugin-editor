import { expect, test } from 'vitest';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import * as A from '@automerge/automerge';
import { Workspace, type FileDoc } from '../../src/index.js';
import { fixture, closeWorkspace, trackWorkspace } from '../fixture.js';

test('two processes cannot concurrently own the same workspace store and a closed owner releases its lock', async () => {
  const { workspace, root, directory } = await fixture();
  const state = path.join(directory, 'state');
  await expect(Workspace.load(root, state)).rejects.toThrow('already open');
  await closeWorkspace(workspace);
  const reopened = trackWorkspace(await Workspace.load(root, state));
  expect((await reopened.open('note.md')).path).toBe('note.md');
});

test('closing the last acknowledged owner unloads the document and reopening retains its identity and text', async () => {
  const { workspace, handle } = await fixture();
  const original = handle.url;
  await workspace.open('note.md', true);
  await workspace.open('note.md', true);
  handle.change((doc) => A.updateText(doc, ['content'], 'Durable after release\n'));
  await workspace.release('note.md', handle.heads());
  expect(workspace.metrics().activeSessions).toBe(1);
  await workspace.release('note.md', handle.heads());
  expect(workspace.metrics()).toMatchObject({ sessions: 0, activeSessions: 0, cachedDocuments: 0 });
  const reopened = await workspace.open('note.md', true);
  expect(reopened.url).toBe(original);
  expect((await workspace.repo.find<FileDoc>(original)).doc().content).toBe(
    'Durable after release\n',
  );
});

test('temporary history and browsing operations keep document and directory caches bounded', async () => {
  const { workspace, root } = await fixture();
  for (let index = 0; index < 40; index++) {
    const folder = `folder-${index}`;
    await mkdir(path.join(root, folder));
    await writeFile(path.join(root, folder, 'note.md'), `Note ${index}\n`);
    await workspace.history(`${folder}/note.md`);
    await workspace.browse(folder);
  }
  expect(workspace.metrics().sessions).toBeLessThanOrEqual(Workspace.inactiveLimit);
  expect(workspace.metrics().cachedDocuments).toBeLessThanOrEqual(Workspace.inactiveLimit);
  expect(workspace.metrics().browsedDirectories).toBeLessThanOrEqual(Workspace.inactiveLimit);
});

test('failed projections retain durable history and can be copied after restart without touching invalid bytes', async () => {
  const { workspace, handle, file, root, directory } = await fixture();
  await workspace.open('note.md', true);
  handle.change((doc) => A.updateText(doc, ['content'], 'Recover this local text\n'));
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  const released = await workspace.release('note.md', handle.heads());
  expect(released.warning).toContain('local history');
  expect(workspace.metrics()).toMatchObject({ activeSessions: 0, failedSessions: 1 });
  await closeWorkspace(workspace, { project: false });
  const reopened = trackWorkspace(await Workspace.load(root, path.join(directory, 'state')));
  const info = await reopened.open('note.md', true);
  expect(info.url).toBe(handle.url);
  expect((await reopened.repo.find<FileDoc>(info.url)).doc().content).toBe(
    'Recover this local text\n',
  );
  await reopened.copy('note.md', 'recovered.txt');
  expect(await readFile(path.join(root, 'recovered.txt'), 'utf8')).toBe(
    'Recover this local text\n',
  );
  expect(await readFile(file)).toEqual(Buffer.from([0xff, 0xfe]));
  await closeWorkspace(reopened, { project: false });
});

test('replacing an open file with an outside symlink cannot export changes to its target', async () => {
  const { workspace, handle, file, directory } = await fixture();
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, 'Outside original\n');
  await rm(file);
  await symlink(outside, file);
  try {
    handle.change((doc) => A.updateText(doc, ['content'], 'Local unsaved text\n'));
    await expect(workspace.flush()).rejects.toThrow();
    await workspace.checkpoint();
    expect(await readFile(outside, 'utf8')).toBe('Outside original\n');
    expect((await workspace.recoverySnapshot())[0].text).toBe('Local unsaved text\n');
  } finally {
    await rm(file);
    await writeFile(file, '# Restored\n');
  }
});
