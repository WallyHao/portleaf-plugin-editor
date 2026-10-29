import { expect, test } from 'vitest';
import { readFile, writeFile, readdir, rename, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Workspace, type FileDoc } from '../../src/index.js';
import { MoveJournal } from '../../src/moves.js';
import type { RecordEntry } from '../../src/metadata.js';
import { fixture, closeWorkspace, trackWorkspace } from '../fixture.js';

async function pendingMove() {
  const data = await fixture('Original document\n');
  await closeWorkspace(data.workspace);
  const state = path.join(data.directory, 'state');
  const [store] = await readdir(state);
  const storage = path.join(state, store);
  const index = JSON.parse(await readFile(path.join(storage, 'index.json'), 'utf8')) as Record<
    string,
    RecordEntry
  >;
  const journal = new MoveJournal(data.root, storage);
  const move = await journal.prepare('note.md', 'renamed.md', index['note.md']);
  return { ...data, state, storage, index, journal, move };
}

test('an interrupted prepared move keeps the original identity and clears an unpublished intent', async () => {
  const { root, state, journal, handle } = await pendingMove();
  const workspace = trackWorkspace(await Workspace.load(root, state));
  expect((await workspace.open('note.md')).url).toBe(handle.url);
  expect(await journal.read()).toBeUndefined();
});

test.each(['before-index', 'after-index'] as const)(
  'recovers a published move %s without splitting document history',
  async (phase) => {
    const { root, state, storage, index, journal, move, handle } = await pendingMove();
    await journal.publish(move);
    if (phase === 'after-index') {
      index['renamed.md'] = index['note.md'];
      delete index['note.md'];
      await writeFile(path.join(storage, 'index.json'), JSON.stringify(index));
    }
    const workspace = trackWorkspace(await Workspace.load(root, state));
    const info = await workspace.open('renamed.md');
    expect(info.url).toBe(handle.url);
    expect((await workspace.repo.find<FileDoc>(info.url)).doc()).toMatchObject({
      name: 'renamed.md',
      content: 'Original document\n',
    });
    expect(await workspace.list()).toEqual(['renamed.md']);
    expect(await journal.read()).toBeUndefined();
  },
);

test('a concurrently created target is never overwritten and a failed move does not change the source identity', async () => {
  const { root, state, journal, move, handle } = await pendingMove();
  await writeFile(path.join(root, 'renamed.md'), 'Concurrent writer\n');
  await expect(journal.publish(move)).rejects.toThrow('overwrite');
  expect(await readFile(path.join(root, 'renamed.md'), 'utf8')).toBe('Concurrent writer\n');
  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('Original document\n');
  const workspace = trackWorkspace(await Workspace.load(root, state));
  expect((await workspace.open('note.md')).url).toBe(handle.url);
});

test('a dangling target symlink is preserved instead of being overwritten or followed', async () => {
  const { root, journal, move } = await pendingMove();
  const target = path.join(root, 'renamed.md');
  await symlink('missing.md', target);
  await expect(journal.publish(move)).rejects.toThrow();
  expect((await lstat(target)).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('Original document\n');
});

test('recovery preserves conflicting replacements and the journal instead of deleting another writer’s file', async () => {
  const { root, state, journal } = await pendingMove();
  await rename(path.join(root, 'note.md'), path.join(root, 'original-kept.md'));
  await writeFile(path.join(root, 'note.md'), 'Replacement source\n');
  await writeFile(path.join(root, 'renamed.md'), 'Replacement target\n');
  await expect(Workspace.load(root, state)).rejects.toThrow('recovery conflict');
  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('Replacement source\n');
  expect(await readFile(path.join(root, 'renamed.md'), 'utf8')).toBe('Replacement target\n');
  expect(await journal.read()).toBeDefined();
});
