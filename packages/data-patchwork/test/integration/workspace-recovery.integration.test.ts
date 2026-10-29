import { expect, test } from 'vitest';
import { readFile, rm, copyFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Workspace, type FileDoc } from '../../src/index.js';
import { fixture, closeWorkspace, trackWorkspace, trackChild, stopChild } from '../fixture.js';
import path from 'node:path';
import * as A from '@automerge/automerge';

test('keeps deleted documents recoverable without recreating their files', async () => {
  const { file, workspace, handle } = await fixture();
  await rm(file);
  handle.change((doc) => A.splice(doc, ['content'], 0, 0, 'Recovered text\n'));
  await workspace.flush();
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (await workspace.history('note.md')).some((version) => version.text.includes('Recovered text')),
  ).toBe(true);
});

test('can reopen a detached document from local history after restart', async () => {
  const { directory, root, file, workspace, handle } = await fixture();
  await rm(file);
  handle.change((doc) => A.splice(doc, ['content'], 0, 0, 'Keep this document.\n'));
  await closeWorkspace(workspace);
  const reopened = await Workspace.load(root, path.join(directory, 'state'));
  trackWorkspace(reopened);
  expect(await reopened.list()).toContain('note.md');
  const info = await reopened.open('note.md');
  expect(info.deleted).toBe(true);
  expect((await reopened.repo.find<FileDoc>(info.url)).doc().content).toContain(
    'Keep this document.',
  );
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('recovers a durable operation after SIGKILL before Markdown projection', async () => {
  const { directory, root, file, workspace } = await fixture('Original.\n');
  await closeWorkspace(workspace);
  const executable = path.join(directory, 'crash-worker.cjs');
  await build({
    entryPoints: ['packages/data-patchwork/test/crash-worker.ts'],
    outfile: executable,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const require = createRequire(import.meta.url);
  await copyFile(
    require.resolve('@automerge/automerge/automerge.wasm'),
    path.join(directory, 'automerge_wasm_bg.wasm'),
  );
  const child = trackChild(
    fork(executable, [root, path.join(directory, 'state')], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = () => finish();
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) =>
      finish(new Error(`Worker exited before acknowledgement (${code}).`));
    const timer = setTimeout(
      () => finish(new Error('Worker persistence acknowledgement timed out.')),
      5000,
    );
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  await stopChild(child);
  expect(await readFile(file, 'utf8')).toBe('Original.\n');
  const reopened = await Workspace.load(root, path.join(directory, 'state'));
  trackWorkspace(reopened);
  await reopened.open('note.md');
  expect(await readFile(file, 'utf8')).toBe('Durable before projection.\nOriginal.\n');
});
