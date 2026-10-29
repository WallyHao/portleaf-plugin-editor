import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import writeFileAtomic from 'write-file-atomic';
import { hash } from './format.js';

export async function ensureDirectory(directory: string) {
  const first = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!first) return;
  const parent = path.dirname(first);
  for (let current = directory; ; current = path.dirname(current)) {
    await syncDirectory(current);
    if (current === parent) break;
  }
}

export async function atomicWrite(file: string, data: string | Buffer) {
  await ensureDirectory(path.dirname(file));
  await writeFileAtomic(file, data, { fsync: true, mode: 0o600 });
  await syncDirectory(path.dirname(file));
}

export async function readRegular(file: string) {
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await descriptor.stat()).isFile()) throw new Error('Choose a regular text file.');
    return await descriptor.readFile();
  } finally {
    await descriptor.close();
  }
}

// Unlike write-file-atomic, document projection must never resolve a replaced target symlink.
export async function projectFile(
  file: string,
  data: Buffer,
  expectedHash: string,
): Promise<boolean> {
  const original = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.portleaf-${randomUUID()}.tmp`,
  );
  try {
    const details = await original.stat();
    if (!details.isFile() || hash(await original.readFile()) !== expectedHash) return false;
    const output = await open(temporary, 'wx', details.mode & 0o777);
    try {
      await output.writeFile(data);
      await output.chown(details.uid, details.gid).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPERM') throw error;
      });
      await output.chmod(details.mode & 0o777);
      await output.sync();
    } finally {
      await output.close();
    }
    const current = await lstat(file);
    if (
      !current.isFile() ||
      current.dev !== details.dev ||
      current.ino !== details.ino ||
      hash(await readRegular(file)) !== expectedHash
    )
      return false;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
    return true;
  } finally {
    await original.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function syncDirectory(file: string) {
  const directory = await open(file, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class DurableStorage extends NodeFSStorageAdapter {
  private pending = new Set<Promise<void>>();
  constructor(private directory: string) {
    super(directory);
  }

  override save(keys: string[], data: Uint8Array): Promise<void> {
    const [id, ...rest] = keys;
    const operation = atomicWrite(
      path.join(this.directory, id.slice(0, 2), id.slice(2), ...rest),
      Buffer.from(data),
    );
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  async drain() {
    while (this.pending.size) await Promise.all(this.pending);
  }
}
