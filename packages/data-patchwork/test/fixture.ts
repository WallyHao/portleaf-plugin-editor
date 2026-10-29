import { afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Workspace, type FileDoc } from '../src/index.js';
import { stopProcess } from '../../../tests/support/process.js';

const workspaces = new Set<Workspace>();
const directories = new Set<string>();
const children = new Set<ChildProcess>();

export function trackChild(child: ChildProcess) {
  children.add(child);
  return child;
}

export async function stopChild(child: ChildProcess) {
  await stopProcess(child, 'Data worker');
  children.delete(child);
}

export function trackWorkspace(workspace: Workspace) {
  workspaces.add(workspace);
  return workspace;
}

export async function closeWorkspace(workspace: Workspace, options?: { project?: boolean }) {
  await workspace.close(options);
  workspaces.delete(workspace);
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const child of [...children].reverse()) {
    try {
      await stopChild(child);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const workspace of [...workspaces].reverse()) {
    try {
      await closeWorkspace(workspace);
    } catch (error) {
      failures.push(error);
    }
  }
  // Do not remove a store that is still owned by a workspace which failed to close.
  if (!workspaces.size && !children.size) {
    for (const directory of directories) {
      try {
        await rm(directory, { recursive: true, force: true });
        directories.delete(directory);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Workspace fixture cleanup failed.');
});

export async function fixture(content = '# Title\n\nFirst paragraph.\n\nLast paragraph.\n') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-data-'));
  directories.add(directory);
  const root = path.join(directory, 'notes');
  await mkdir(root);
  const file = path.join(root, 'note.md');
  await writeFile(file, content);
  const workspace = trackWorkspace(await Workspace.load(root, path.join(directory, 'state')));
  const info = await workspace.open('note.md');
  const handle = await workspace.repo.find<FileDoc>(info.url);
  return { directory, root, file, workspace, handle };
}
