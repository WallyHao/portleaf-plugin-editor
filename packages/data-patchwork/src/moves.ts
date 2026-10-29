import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, syncDirectory } from './storage.js';
import { object, record, relativePath, type RecordEntry } from './metadata.js';

const execute = promisify(execFile);
type Identity = { device: string; inode: string };
export type PendingMove = {
  version: 1;
  from: string;
  to: string;
  identity: Identity;
  record: RecordEntry;
};

async function identity(file: string): Promise<Identity | undefined> {
  try {
    const details = await lstat(file, { bigint: true });
    if (!details.isFile()) return;
    return { device: String(details.dev), inode: String(details.ino) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const same = (a: Identity | undefined, b: Identity) =>
  a?.device === b.device && a.inode === b.inode;

export class MoveJournal {
  private file: string;
  constructor(
    private root: string,
    directory: string,
  ) {
    this.file = path.join(directory, 'move.json');
  }
  private async confined(file: string) {
    if (!relativePath(file)) throw new Error('Invalid move journal path.');
    const resolved = path.join(
      await realpath(path.dirname(path.join(this.root, file))),
      path.basename(file),
    );
    const relative = path.relative(this.root, resolved);
    if (!relativePath(relative))
      throw new Error('Move journal path resolves outside the opened folder.');
    return resolved;
  }
  async read(): Promise<PendingMove | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (
      !object(value) ||
      value.version !== 1 ||
      !relativePath(value.from) ||
      !relativePath(value.to) ||
      value.from === value.to ||
      !record(value.record) ||
      !object(value.identity) ||
      typeof value.identity.device !== 'string' ||
      typeof value.identity.inode !== 'string'
    )
      throw new Error('Invalid move journal. Preserve the workspace store for recovery.');
    return value as PendingMove;
  }
  async prepare(from: string, to: string, entry: RecordEntry): Promise<PendingMove> {
    if (await this.read()) throw new Error('A previous move needs recovery before another rename.');
    const source = await this.confined(from);
    await this.confined(to);
    const original = await identity(source);
    if (!original) throw new Error('The rename source is no longer a regular file.');
    const move: PendingMove = {
      version: 1,
      from,
      to,
      identity: original,
      record: structuredClone(entry),
    };
    await atomicWrite(this.file, JSON.stringify(move) + '\n');
    return move;
  }
  async publish(move: PendingMove) {
    const source = await this.confined(move.from),
      target = await this.confined(move.to);
    if (!same(await identity(source), move.identity))
      throw new Error(
        'The rename source changed. Both file paths and the move journal were preserved.',
      );
    // GNU coreutils uses native no-replace rename on Linux. No copy/unlink fallback across devices.
    // execFile passes paths as arguments, including spaces and shell metacharacters.
    try {
      await execute(
        process.env.PORTLEAF_MV || 'mv',
        ['--no-copy', '--update=none-fail', '--no-target-directory', '--', source, target],
        { timeout: 10_000, maxBuffer: 64_000 },
      );
    } catch (error) {
      if ((await this.outcome(move)) === 'unchanged') {
        // A confirmed failed publication has not changed our source or its document identity.
        await this.clear();
      }
      throw new Error(
        `Rename failed without permission to overwrite the destination: ${String(error)}`,
        { cause: error },
      );
    }
    await syncDirectory(path.dirname(target));
    if (path.dirname(source) !== path.dirname(target)) await syncDirectory(path.dirname(source));
  }
  async outcome(move: PendingMove): Promise<'moved' | 'unchanged'> {
    const source = await this.confined(move.from),
      target = await this.confined(move.to);
    const [from, to] = await Promise.all([identity(source), identity(target)]);
    if (same(to, move.identity) && !same(from, move.identity)) return 'moved';
    if (same(from, move.identity) && !same(to, move.identity)) return 'unchanged';
    throw new Error(
      `Rename recovery conflict: ${move.from} → ${move.to}. Files and move.json were preserved; restore the original file before retrying.`,
    );
  }
  async clear() {
    await unlink(this.file);
    await syncDirectory(path.dirname(this.file));
  }
}
