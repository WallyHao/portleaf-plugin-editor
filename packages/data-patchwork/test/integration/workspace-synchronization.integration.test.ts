import { expect, test, vi } from 'vitest';
import { encodeHeads } from '@automerge/automerge-repo';
import { readFile, writeFile, rm, rename } from 'node:fs/promises';
import { type FileDoc } from '../../src/index.js';
import { fixture } from '../fixture.js';
import path from 'node:path';
import * as A from '@automerge/automerge';

test('flush reports an invalid file while exporting later healthy documents', async () => {
  const { root, file, workspace } = await fixture();
  const healthy = path.join(root, 'healthy.md');
  await writeFile(healthy, 'Healthy original\n');
  const info = await workspace.open('healthy.md');
  const handle = await workspace.repo.find<FileDoc>(info.url);
  try {
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    handle.change((doc) => A.updateText(doc, ['content'], 'Healthy updated\n'));
    await expect(workspace.flush()).rejects.toThrow('note.md:');
    expect(await readFile(healthy, 'utf8')).toBe('Healthy updated\n');
    expect(await readFile(file)).toEqual(Buffer.from([0xff, 0xfe]));
  } finally {
    await writeFile(file, '# Repaired\n');
  }
});

test('flush includes every failed file instead of stopping at the first error', async () => {
  const { root, file, workspace } = await fixture();
  const second = path.join(root, 'second.md');
  await writeFile(second, 'Second original\n');
  await workspace.open('second.md');
  try {
    await writeFile(file, Buffer.from([0xff]));
    await writeFile(second, Buffer.from([0xfe]));
    const failure = await workspace.flush().then(
      () => {
        throw new Error('Expected both file imports to fail.');
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain('note.md:');
    expect((failure as AggregateError).message).toContain('second.md:');
    expect(await readFile(file)).toEqual(Buffer.from([0xff]));
    expect(await readFile(second)).toEqual(Buffer.from([0xfe]));
  } finally {
    await writeFile(file, '# Repaired first\n');
    await writeFile(second, '# Repaired second\n');
  }
});

test('merges an external change from the disk base, preserving unprojected local edits', async () => {
  const { file, workspace, handle } = await fixture();
  handle.change((doc) => A.splice(doc, ['content'], 8, 0, 'Local 🐾 中文.\n\n'));
  await writeFile(file, '# Title\n\nFirst paragraph.\n\nExternal paragraph.\n');
  await workspace.flush();
  expect(handle.doc().content).toContain('Local 🐾 中文.');
  expect(handle.doc().content).toContain('External paragraph.');
  expect(await readFile(file, 'utf8')).toBe(handle.doc().content);
});

test('updates a live document after atomic replacement by another editor', async () => {
  const { file, handle } = await fixture();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(file + '.tmp', '# Replaced externally\n');
  await rename(file + '.tmp', file);
  await expect.poll(() => handle.doc().content, { timeout: 3000 }).toBe('# Replaced externally\n');
});

test('retains both versions of overlapping edits in CRDT history', async () => {
  const { file, workspace, handle } = await fixture('The cat sat.\n');
  handle.change((doc) => A.updateText(doc, ['content'], 'The dog sat.\n'));
  await writeFile(file, 'The fox sat.\n');
  await workspace.flush();
  const texts = (await workspace.history('note.md')).map((version) => version.text);
  expect(texts).toContain('The dog sat.\n');
  expect(texts).toContain('The fox sat.\n');
  expect(await readFile(file, 'utf8')).toBe(handle.doc().content);
});

test('creates extensionless text and watches external changes and newly created text files', async () => {
  const { root, workspace } = await fixture();
  const info = await workspace.create('LICENSE');
  const handle = await workspace.repo.find<FileDoc>(info.url);
  expect(handle.doc().extension).toBe('');
  handle.change((doc) => A.updateText(doc, ['content'], 'Initial text\n'));
  await workspace.flush();
  await workspace.browse('.', { text: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(path.join(root, 'LICENSE'), 'External text\n');
  await expect.poll(() => handle.doc().content).toBe('External text\n');
  const events: string[] = [];
  workspace.on('status', (event) => {
    if (event.type === 'files') events.push(event.file);
  });
  await writeFile(path.join(root, 'new.txt'), 'New text\n');
  await expect.poll(() => events).toContain('new.txt');
  await rm(path.join(root, 'LICENSE'));
  await workspace.flush();
  expect(await workspace.list()).not.toContain('LICENSE');
  expect(await workspace.list('.', { text: true })).toContain('LICENSE');
});

test('acknowledges coalesced edit-and-undo synchronization even when document text does not change', async () => {
  const { workspace, handle, file } = await fixture('Original\n');
  let remote = A.clone(handle.doc());
  remote = A.change(remote, (doc) => A.splice(doc, ['content'], 0, 0, 'Temporary '));
  remote = A.change(remote, (doc) => A.splice(doc, ['content'], 0, 'Temporary '.length, ''));
  const before = handle.listenerCount('heads-changed');
  const acknowledged = workspace.awaitHeads(handle.url, encodeHeads(A.getHeads(remote)));
  await vi.waitFor(() => expect(handle.listenerCount('heads-changed')).toBe(before + 1));
  const visibleChange = vi.fn();
  handle.on('change', visibleChange);
  handle.update((doc) => A.merge(doc, remote));
  await acknowledged;
  expect(visibleChange).not.toHaveBeenCalled();
  expect(handle.listenerCount('heads-changed')).toBe(before);
  await workspace.flush();
  expect(await readFile(file, 'utf8')).toBe('Original\n');
  expect(
    (await workspace.history('note.md')).some((version) => version.text === 'Temporary Original\n'),
  ).toBe(true);
});
