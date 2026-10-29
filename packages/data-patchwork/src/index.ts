import { EventEmitter, once } from 'node:events';
import { mkdir, readFile, readdir, realpath, stat, glob, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as A from '@automerge/automerge';
import {
  Repo,
  decodeHeads,
  type DocHandle,
  type AutomergeUrl,
  type UrlHeads,
} from '@automerge/automerge-repo';
import {
  getType,
  type UnixFileEntry,
  type HasPatchworkMetadata,
} from '@inkandswitch/patchwork-filesystem';
import { watch, type FSWatcher } from 'chokidar';
import {
  DurableStorage,
  atomicWrite,
  syncDirectory,
  ensureDirectory,
  readRegular,
  projectFile,
} from './storage.js';
import { decode, encode, hash } from './format.js';
import { parseIndex, type RecordEntry } from './metadata.js';
import { MoveJournal } from './moves.js';
import { acquireWorkspaceLock } from './lock.js';
export { atomicWrite } from './storage.js';

export type FileDoc = UnixFileEntry & HasPatchworkMetadata<'file'> & { content: string };
type BrowseOptions = {
  text?: boolean;
  extensions?: readonly string[];
  excludedExtensions?: readonly string[];
};
type Session = {
  file: string;
  record: RecordEntry;
  handle: DocHandle<FileDoc>;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  firstChange?: number;
  error?: Error;
  persistQueued?: boolean;
  owners: number;
  retiring?: boolean;
  onHeads(): void;
};
export type DataEvent = {
  type: 'error' | 'deleted' | 'changed' | 'files' | 'renamed' | 'unavailable';
  file: string;
  previousFile?: string;
  message?: string;
  readOnly?: boolean;
};
export type FileInfo = { path: string; url: AutomergeUrl; deleted: boolean; readOnly: boolean };
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
};

export class Workspace extends EventEmitter {
  readonly repo: Repo;
  readonly root: string;
  private storage: DurableStorage;
  private watcher: FSWatcher;
  private records: Record<string, RecordEntry> = Object.create(null);
  private sessions = new Map<string, Session>();
  private resources = new Map<string, number>();
  private resourceAliases = new Map<string, { file: string; references: number }>();
  private watchedDirectories = new Map<string, number>();
  private sessionDirectories = new Map<string, number>();
  private operations: Promise<unknown> = Promise.resolve();
  private moves: MoveJournal;
  private metadataQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private stopping = false;
  private evictionTimer?: ReturnType<typeof setTimeout>;
  private unlock?: () => Promise<void>;
  private lockError?: Error;
  private unwatchedPaths = 0;
  private watcherResets = 0;
  static readonly inactiveLimit = 16;

  private constructor(
    root: string,
    private stateDirectory: string,
  ) {
    super();
    this.root = root;
    this.moves = new MoveJournal(root, stateDirectory);
    this.storage = new DurableStorage(path.join(stateDirectory, 'automerge'));
    // All persistence is coordinated below; disable the repo's independent save debounce.
    this.repo = new Repo({ storage: this.storage, saveDebounceRate: 2_147_483_647 });
    this.watcher = this.createWatcher();
  }

  private createWatcher() {
    const watcher = watch([], {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      ignored: (file, stats) => {
        // Explicitly opened notes remain observable, including hidden notes.
        if (this.sessions.has(path.resolve(file)) || this.resources.has(path.resolve(file)))
          return false;
        const relative = path.relative(this.root, file);
        if (!relative || relative.startsWith('..')) return false;
        if (
          relative
            .split(path.sep)
            .some((part) => part.startsWith('.') || ['node_modules', 'dist'].includes(part))
        )
          return true;
        return false;
      },
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
    });
    watcher.on('all', (_event, file) => {
      this.emit('status', {
        type: 'files',
        file: path.relative(this.root, file),
      } satisfies DataEvent);
      const session = this.sessions.get(path.resolve(file));
      if (session && !session.retiring && !this.stopping && !this.closed)
        void this.enqueue(session, () => this.reconcile(session)).catch(() => {});
    });
    watcher.on('error', (error) =>
      this.emit('status', { type: 'error', file: '', message: String(error) }),
    );
    return watcher;
  }

  static async load(root: string, stateRoot: string) {
    root = await realpath(root);
    const directory = path.join(stateRoot, hash(Buffer.from(root)).slice(0, 24));
    await ensureDirectory(directory);
    let workspace: Workspace | undefined, lost: Error | undefined;
    const unlock = await acquireWorkspaceLock(directory, (error) => {
      lost = error;
      workspace?.loseLock(error);
    });
    try {
      workspace = new Workspace(root, directory);
      workspace.unlock = unlock;
      try {
        workspace.records = parseIndex(await readFile(path.join(directory, 'index.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await workspace.recoverMove();
      if (lost) throw lost;
    } catch (error) {
      try {
        if (workspace) {
          await workspace.watcher.close();
          if (!lost) await workspace.repo.shutdown();
        }
      } finally {
        await unlock();
      }
      throw error;
    }
    return workspace;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations
      .catch(() => {})
      .then(() => {
        if (this.closed) throw new Error('The workspace is closed.');
        if (this.lockError) throw this.lockError;
        return operation();
      });
    this.operations = task;
    return task;
  }

  private loseLock(error: Error) {
    this.lockError = error;
    this.stopping = true;
    clearTimeout(this.evictionTimer);
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    void this.watcher.close();
    this.emit('status', {
      type: 'unavailable',
      file: '',
      message: error.message,
    } satisfies DataEvent);
  }

  private async recoverMove() {
    const move = await this.moves.read();
    if (!move) return;
    if ((await this.moves.outcome(move)) === 'moved') {
      const existing = this.records[move.to];
      if (existing && existing.url !== move.record.url && !existing.deleted)
        throw new Error(
          'Rename recovery would replace another document identity. Preserve move.json for recovery.',
        );
      const entry = existing?.url === move.record.url ? existing : move.record;
      this.records[move.to] = entry;
      if (this.records[move.from]?.url === move.record.url) delete this.records[move.from];
      const handle = await this.repo.find<FileDoc>(entry.url);
      this.renameMetadata(handle, move.to);
      await this.persist(handle);
      await this.saveIndex();
      await this.repo.removeFromCache(handle.documentId);
    }
    await this.moves.clear();
  }

  private renameMetadata(handle: DocHandle<FileDoc>, file: string) {
    handle.change((doc) => {
      doc.name = path.basename(file);
      doc.extension = path.extname(file).slice(1);
      doc.mimeType = /\.(md|markdown|mdown)$/i.test(file) ? 'text/markdown' : 'text/plain';
    });
  }

  private wantedDirectory(directory: string) {
    const wanted = [
      ...this.watchedDirectories.keys(),
      ...this.sessionDirectories.keys(),
      ...[...this.resources.keys()].map((file) => path.dirname(file)),
    ];
    return wanted.some((file) => file === directory || inside(directory, file));
  }
  private async unwatchDirectory(directory: string) {
    for (
      let current = directory;
      current === this.root || inside(this.root, current);
      current = path.dirname(current)
    ) {
      if (!this.wantedDirectory(current)) {
        await this.watcher.unwatch(current);
        this.unwatchedPaths++;
      }
      if (current === this.root) break;
    }
    if (this.unwatchedPaths >= 128) this.scheduleEviction();
  }

  private async rebuildWatcher() {
    const previous = this.watcher,
      next = this.createWatcher();
    this.watcher = next;
    this.unwatchedPaths = 0;
    try {
      const roots = [
        ...this.watchedDirectories.keys(),
        ...this.sessionDirectories.keys(),
        ...this.sessions.keys(),
        ...this.resources.keys(),
      ];
      if (roots.length) {
        const ready = once(next, 'ready', { signal: AbortSignal.timeout(5000) });
        next.add(roots);
        await ready;
      }
      await previous.close();
      this.watcherResets++;
      // Observe edits which happened while the replacement watcher initialized.
      for (const session of this.sessions.values())
        await this.enqueue(session, () => this.reconcile(session)).catch(() => {});
    } catch (error) {
      await next.close();
      this.watcher = previous;
      previous.add([
        ...this.watchedDirectories.keys(),
        ...this.sessionDirectories.keys(),
        ...this.sessions.keys(),
        ...this.resources.keys(),
      ]);
      throw error;
    }
  }
  private watchSession(file: string) {
    const directory = path.dirname(file);
    this.sessionDirectories.set(directory, (this.sessionDirectories.get(directory) ?? 0) + 1);
    this.watcher.add([directory, file]);
  }
  private async unwatchSession(file: string) {
    const directory = path.dirname(file),
      count = this.sessionDirectories.get(directory) ?? 0;
    if (count > 1) this.sessionDirectories.set(directory, count - 1);
    else this.sessionDirectories.delete(directory);
    if (!this.resources.has(file) && !this.wantedDirectory(directory))
      await this.watcher.unwatch(file);
    await this.unwatchDirectory(directory);
  }

  private async evict(session: Session) {
    if (session.owners || session.error || session.retiring) return;
    session.retiring = true;
    clearTimeout(session.timer);
    try {
      await session.queue;
      await this.reconcile(session);
      await this.persist(session.handle);
      session.handle.off('heads-changed', session.onHeads);
      await this.repo.removeFromCache(session.handle.documentId);
      this.sessions.delete(session.file);
      await this.unwatchSession(session.file);
    } catch (error) {
      session.error = error instanceof Error ? error : new Error(String(error));
      if (session.handle.isReady() && this.sessions.has(session.file)) {
        session.handle.off('heads-changed', session.onHeads);
        session.handle.on('heads-changed', session.onHeads);
      } else this.sessions.delete(session.file);
      this.emit('status', {
        type: 'error',
        file: path.relative(this.root, session.file),
        message: session.error.message,
      });
    } finally {
      session.retiring = false;
    }
  }
  private async trimInactive(exclude?: Session) {
    const inactive = [...this.sessions.values()].filter((session) => !session.owners);
    for (const session of inactive.slice(0, Math.max(0, inactive.length - Workspace.inactiveLimit)))
      if (session !== exclude) await this.evict(session);
  }
  private scheduleEviction() {
    if (this.evictionTimer || this.closed || this.stopping) return;
    this.evictionTimer = setTimeout(() => {
      this.evictionTimer = undefined;
      void this.run(async () => {
        await this.trimInactive();
        if (this.unwatchedPaths >= 128) await this.rebuildWatcher();
      }).catch((error) => this.emit('status', { type: 'error', file: '', message: String(error) }));
    }, 100);
    this.evictionTimer.unref();
  }

  metrics() {
    return {
      sessions: this.sessions.size,
      activeSessions: [...this.sessions.values()].filter((session) => session.owners > 0).length,
      failedSessions: [...this.sessions.values()].filter((session) => !!session.error).length,
      cachedDocuments: Object.keys(this.repo.handles).length,
      directoryWatches: Object.keys(this.watcher.getWatched()).length,
      browsedDirectories: this.watchedDirectories.size,
      resourceReferences: [...this.resources.values()].reduce((sum, count) => sum + count, 0),
      watcherResets: this.watcherResets,
    };
  }

  private async resolveFile(relative: string, existing = true) {
    const file = path.resolve(this.root, relative);
    if (!inside(this.root, file)) throw new Error('The file must be inside the opened folder.');
    const resolved = existing
      ? await realpath(file)
      : path.join(await realpath(path.dirname(file)), path.basename(file));
    if (!inside(this.root, resolved))
      throw new Error('The file resolves outside the opened folder.');
    if (existing && !(await stat(resolved)).isFile()) throw new Error('Choose a text file.');
    return resolved;
  }

  private async visibleFile(file: string, options?: BrowseOptions) {
    if (options?.extensions?.includes(path.extname(file).slice(1).toLowerCase())) return true;
    if (options?.excludedExtensions?.includes(path.extname(file).slice(1).toLowerCase()))
      return false;
    if (/\.(md|markdown|mdown)$/i.test(file)) return true;
    if (!options?.text) return false;
    let descriptor;
    try {
      const resolved = await this.resolveFile(path.relative(this.root, file));
      descriptor = await openFile(resolved, 'r');
      const bytes = Buffer.alloc(8192);
      const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead), {
        stream: bytesRead === bytes.length,
      });
      return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);
    } catch {
      return false;
    } finally {
      await descriptor?.close();
    }
  }

  async list(relative = '.', options?: BrowseOptions): Promise<string[]> {
    const directory = await this.resolveDirectory(relative);
    const files: string[] = [];
    for await (const file of glob('**/*', {
      cwd: directory,
      exclude: (file) =>
        file
          .split(path.sep)
          .some((part) => part.startsWith('.') || ['node_modules', 'dist'].includes(part)),
    })) {
      if (
        (await stat(path.join(directory, file)).catch(() => undefined))?.isFile() &&
        (await this.visibleFile(path.join(directory, file), options))
      )
        files.push(path.relative(this.root, path.join(directory, file)));
      if (files.length >= 10_000) break;
    }
    // Indexed paths remain discoverable when the corresponding file was deleted externally.
    const prefix = path.relative(this.root, directory);
    const indexed = Object.keys(this.records).filter(
      (file) =>
        (options?.text || /\.(md|markdown|mdown)$/i.test(file)) &&
        (!prefix || file.startsWith(prefix + path.sep)) &&
        !file
          .split(path.sep)
          .some((part) => part.startsWith('.') || ['node_modules', 'dist'].includes(part)),
    );
    return [...new Set([...files, ...indexed])].sort((a, b) => a.localeCompare(b));
  }

  private async resolveDirectory(relative: string) {
    const candidate = path.resolve(this.root, relative);
    if (candidate !== this.root && !inside(this.root, candidate))
      throw new Error('Choose a directory inside the opened folder.');
    const directory = await realpath(candidate);
    if (directory !== this.root && !inside(this.root, directory))
      throw new Error('The directory resolves outside the opened folder.');
    if (!(await stat(directory)).isDirectory()) throw new Error('Choose a directory.');
    return directory;
  }

  async browse(relative: string, options?: BrowseOptions) {
    const directory = await this.resolveDirectory(relative);
    this.watcher.add(directory);
    this.watchedDirectories.delete(directory);
    this.watchedDirectories.set(directory, Date.now());
    while (this.watchedDirectories.size > Workspace.inactiveLimit) {
      const oldest = this.watchedDirectories.keys().next().value!;
      this.watchedDirectories.delete(oldest);
      await this.unwatchDirectory(oldest);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const files: { name: string; path: string; directory: boolean; deleted?: boolean }[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() &&
        !(entry.isFile() && (await this.visibleFile(path.join(directory, entry.name), options)))
      )
        continue;
      files.push({
        name: entry.name,
        path: path.relative(this.root, path.join(directory, entry.name)),
        directory: entry.isDirectory(),
      });
    }
    for (const file of Object.keys(this.records)) {
      if (
        (options?.text || /\.(md|markdown|mdown)$/i.test(file)) &&
        path.dirname(path.resolve(this.root, file)) === directory &&
        !files.some((entry) => entry.path === file)
      )
        files.push({ name: path.basename(file), path: file, directory: false, deleted: true });
    }
    return files.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }

  async preview(relative: string) {
    const file = await this.resolveFile(relative).catch((error) => {
      const candidate = path.resolve(this.root, relative);
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        inside(this.root, candidate) &&
        this.sessions.has(candidate)
      )
        return candidate;
      throw error;
    });
    const session = this.sessions.get(file);
    if (session) return session.handle.doc().content.slice(0, 32_000);
    const descriptor = await openFile(file, 'r');
    try {
      const bytes = Buffer.alloc(128_000);
      const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
      // Streaming decode retains a partial final UTF-8 sequence instead of corrupting it.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead), {
        stream: true,
      });
      if (text.includes('\0')) throw new Error('This file contains binary data.');
      return text.replaceAll('\r\n', '\n').slice(0, 32_000);
    } finally {
      await descriptor.close();
    }
  }

  async mkdir(relative: string) {
    const directory = await this.resolveDirectory(path.dirname(relative));
    const target = path.join(directory, path.basename(relative));
    if (!inside(this.root, target)) throw new Error('Choose a directory inside the opened folder.');
    await mkdir(target);
    await syncDirectory(directory);
    return path.relative(this.root, target);
  }

  async copy(relative: string, target: string) {
    return this.run(async () => {
      const info = await this.openRecoverable(relative);
      const session = this.sessions.get(path.resolve(this.root, info.path))!;
      try {
        await this.flushSessions([session]);
      } catch {
        await this.persist(session.handle);
      }
      const file = await this.resolveFile(target, false);
      await this.checkNewIdentity(file);
      let bytes: Buffer;
      if (session.record.base.format.mixed) {
        try {
          bytes = await readRegular(session.file);
          decode(bytes);
        } catch {
          bytes = encode(session.handle.doc().content, {
            ...session.record.base.format,
            mixed: false,
          });
        }
      } else bytes = encode(session.handle.doc().content, session.record.base.format);
      const descriptor = await openFile(file, 'wx');
      try {
        await descriptor.writeFile(bytes);
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      await syncDirectory(path.dirname(file));
      return this.openSession(path.relative(this.root, file));
    });
  }

  async create(relative: string, retain = false) {
    return this.run(async () => {
      const file = await this.resolveFile(relative, false);
      await this.checkNewIdentity(file);
      const descriptor = await openFile(file, 'wx');
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      await syncDirectory(path.dirname(file));
      return this.openSession(path.relative(this.root, file), retain);
    });
  }

  async imageFile(note: string, source: string) {
    const base = path.resolve(this.root, note);
    if (!inside(this.root, base)) throw new Error('The note must be inside the opened folder.');
    const url = new URL(source, pathToFileURL(base));
    if (url.protocol !== 'file:') throw new Error('Invalid image path.');
    const file = await realpath(fileURLToPath(url));
    if (!inside(this.root, file) || !/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(file))
      throw new Error('Choose an image inside the opened folder.');
    return file;
  }

  private async checkNewIdentity(file: string) {
    if (!this.records[path.relative(this.root, file)]) return;
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          'This path has detached local history. Choose a new name to preserve both document identities.',
        );
      throw error;
    }
  }

  async resourceFile(relative: string) {
    return this.resolveFile(relative);
  }

  async inspect(relative: string) {
    const file = await this.resolveFile(relative);
    const details = await stat(file);
    return {
      path: path.relative(this.root, file),
      size: details.size,
      modifiedAt: details.mtimeMs,
      deleted: false,
      readOnly: true,
    };
  }

  async watchResource(relative: string, enabled: boolean) {
    const candidate = path.resolve(this.root, relative);
    if (!enabled) {
      const alias = this.resourceAliases.get(candidate);
      if (!alias) return;
      if (alias.references > 1) alias.references--;
      else this.resourceAliases.delete(candidate);
      const file = alias.file,
        references = this.resources.get(file) ?? 0;
      if (references > 1) this.resources.set(file, references - 1);
      else if (
        this.resources.delete(file) &&
        !this.sessions.has(file) &&
        !this.wantedDirectory(path.dirname(file))
      )
        await this.watcher.unwatch(file);
      await this.unwatchDirectory(path.dirname(file));
      return;
    }
    const file = await this.resolveFile(relative);
    const alias = this.resourceAliases.get(candidate);
    if (alias && alias.file !== file)
      throw new Error('The watched resource alias changed. Release it before watching again.');
    this.resourceAliases.set(candidate, { file, references: (alias?.references ?? 0) + 1 });
    this.resources.set(file, (this.resources.get(file) ?? 0) + 1);
    this.watcher.add(file);
  }

  async open(relative: string, retain = false): Promise<FileInfo> {
    return this.run(() => this.openSession(relative, retain));
  }

  private async openSession(relative: string, retain = false): Promise<FileInfo> {
    const file = await this.resolveFile(relative).catch((error) => {
      const candidate = path.resolve(this.root, relative);
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        inside(this.root, candidate) &&
        this.records[path.relative(this.root, candidate)]
      )
        return candidate;
      throw error;
    });
    let session = this.sessions.get(file);
    if (session) {
      // A retained failed projection is still a valid editable CRDT document.
      try {
        await this.enqueue(session, () => this.reconcile(session!));
      } catch (error) {
        if (!retain) throw error;
      }
      if (retain) session.owners++;
      this.sessions.delete(file);
      this.sessions.set(file, session);
      return this.info(session);
    }
    const key = path.relative(this.root, file);
    let record = this.records[key];
    let handle: DocHandle<FileDoc>;
    if (record) {
      handle = await this.repo.find<FileDoc>(record.url);
      if (getType(handle.doc()) !== 'file') throw new Error('Invalid Patchwork file document.');
    } else {
      const bytes = await readRegular(file);
      const { text, format } = decode(bytes);
      handle = this.repo.create<FileDoc>({
        '@patchwork': { type: 'file' },
        name: path.basename(file),
        extension: path.extname(file).slice(1),
        mimeType: /\.(md|markdown|mdown)$/i.test(file) ? 'text/markdown' : 'text/plain',
        content: text,
      });
      record = { url: handle.url, base: { hash: hash(bytes), heads: handle.heads(), format } };
      await this.persist(handle);
      this.records[key] = record;
      await this.saveIndex();
    }
    session = {
      file,
      record,
      handle,
      queue: Promise.resolve(),
      owners: retain ? 1 : 0,
      onHeads: () => {},
    };
    this.sessions.set(file, session);
    const active = session;
    session.onHeads = () => this.schedule(active);
    handle.on('heads-changed', session.onHeads);
    this.watchSession(file);
    try {
      await this.enqueue(session, () => this.reconcile(active));
    } catch (error) {
      if (!retain) throw error;
    }
    await this.trimInactive(session);
    return this.info(session);
  }

  private async openRecoverable(relative: string) {
    try {
      return await this.openSession(relative);
    } catch (error) {
      const canonical = await realpath(path.resolve(this.root, relative)).catch(() =>
        path.resolve(this.root, relative),
      );
      const cached =
        this.sessions.get(canonical) ?? this.sessions.get(path.resolve(this.root, relative));
      if (!cached) throw error;
      await this.persist(cached.handle);
      return this.info(cached);
    }
  }

  private async finishPendingMove() {
    const move = await this.moves.read();
    if (!move || this.records[move.to]?.url !== move.record.url) return;
    if ((await this.moves.outcome(move)) !== 'moved') return;
    const session = this.sessions.get(path.resolve(this.root, move.to));
    if (!session) return;
    await this.persist(session.handle);
    await syncDirectory(path.dirname(path.resolve(this.root, move.from)));
    await syncDirectory(path.dirname(session.file));
    await this.saveIndex();
    await this.moves.clear();
  }

  async release(relative: string, heads?: UrlHeads, url?: AutomergeUrl) {
    return this.run(async () => {
      const session =
        this.sessions.get(path.resolve(this.root, relative)) ??
        [...this.sessions.values()].find((candidate) => url && candidate.handle.url === url);
      if (!session) return {};
      if (heads) await this.awaitHeads(session.handle.url, heads);
      let warning: string | undefined;
      try {
        await this.flushSessions([session]);
      } catch (error) {
        warning = String(error);
      }
      // Never release the last renderer owner until local recovery is durable.
      await this.enqueue(session, () => this.persist(session.handle), false);
      session.owners = Math.max(0, session.owners - 1);
      if (!session.owners) await this.evict(session);
      if (session.error && !warning) warning = session.error.message;
      return warning ? { warning: `${warning}\nChanges were kept in local history.` } : {};
    });
  }

  async releaseAll() {
    return this.run(async () => {
      await this.checkpointSessions();
      for (const session of [...this.sessions.values()]) {
        session.owners = 0;
        await this.evict(session);
      }
      const directories = [
        ...this.watchedDirectories.keys(),
        ...[...this.resources.keys()].map((file) => path.dirname(file)),
      ];
      this.watchedDirectories.clear();
      this.resources.clear();
      this.resourceAliases.clear();
      for (const directory of directories) await this.unwatchDirectory(directory);
    });
  }

  private info(session: Session): FileInfo {
    return {
      path: path.relative(this.root, session.file),
      url: session.handle.url,
      deleted: !!session.record.deleted,
      readOnly: session.record.base.format.mixed,
    };
  }

  private saveIndex() {
    const contents = JSON.stringify(this.records);
    const task = this.metadataQueue
      .catch(() => {})
      .then(() => {
        if (this.lockError) throw this.lockError;
        return atomicWrite(path.join(this.stateDirectory, 'index.json'), contents);
      });
    this.metadataQueue = task;
    return task;
  }

  private async persist(handle: DocHandle<FileDoc>) {
    await this.repo.flush([handle.documentId]);
    await this.storage.drain();
  }

  private enqueue(session: Session, operation: () => Promise<void>, clearsError = true) {
    const task = session.queue
      .catch(() => {})
      .then(() => {
        if (this.lockError) throw this.lockError;
        return operation();
      })
      .then(() => {
        if (clearsError) session.error = undefined;
        this.scheduleEviction();
      });
    session.queue = task;
    void task.catch((error) => {
      session.error = error instanceof Error ? error : new Error(String(error));
      this.emit('status', {
        type: 'error',
        file: path.relative(this.root, session.file),
        message: session.error.message,
      } satisfies DataEvent);
    });
    return task;
  }

  private schedule(session: Session) {
    if (this.closed || this.stopping || session.retiring) return;
    // Persist every batch independently of the slower Markdown projection.
    if (!session.persistQueued) {
      session.persistQueued = true;
      void this.enqueue(
        session,
        async () => {
          session.persistQueued = false;
          await this.persist(session.handle);
        },
        false,
      ).catch(() => {});
    }
    session.firstChange ??= Date.now();
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => {
        session.firstChange = undefined;
        void this.enqueue(session, () => this.reconcile(session)).catch(() => {});
      },
      Math.min(150, Math.max(0, 500 - (Date.now() - session.firstChange))),
    );
  }

  private async reconcile(session: Session, attempts = 0): Promise<void> {
    const { handle, record, file } = session;
    let bytes: Buffer;
    try {
      const resolved = await this.resolveFile(path.relative(this.root, file));
      if (resolved !== file)
        throw new Error('The opened path now points to another file. Local history was kept.');
      bytes = await readRegular(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      record.deleted = true;
      await this.persist(handle);
      await this.saveIndex();
      this.emit('status', {
        type: 'deleted',
        file: path.relative(this.root, file),
        message: 'File removed externally. Your document remains in local history.',
      } satisfies DataEvent);
      return;
    }
    const diskHash = hash(bytes);
    if (record.pending?.hash === diskHash) record.base = record.pending;
    if (record.pending) {
      delete record.pending;
      await this.saveIndex();
    }
    if (diskHash !== record.base.hash) {
      const { text, format } = decode(bytes);
      const externalHeads = handle.changeAt(
        record.base.heads,
        (doc) => A.updateText(doc, ['content'], text),
        { message: 'External file update' },
      );
      await this.persist(handle);
      record.base = { hash: diskHash, heads: externalHeads ?? record.base.heads, format };
      delete record.deleted;
      await this.saveIndex();
      this.emit('status', {
        type: 'changed',
        file: path.relative(this.root, file),
        readOnly: format.mixed,
      } satisfies DataEvent);
    }
    if (record.deleted) {
      delete record.deleted;
      await this.saveIndex();
      this.emit('status', {
        type: 'changed',
        file: path.relative(this.root, file),
        readOnly: record.base.format.mixed,
      } satisfies DataEvent);
    }
    const doc = handle.doc();
    const baseText = handle.view(record.base.heads).doc().content;
    if (doc.content === baseText) {
      await this.persist(handle);
      return;
    }
    const projected = encode(doc.content, record.base.format);
    const projectedHeads = handle.heads();
    await this.persist(handle);
    record.pending = { hash: hash(projected), heads: projectedHeads, format: record.base.format };
    await this.saveIndex();
    // Recheck after journaling; another editor may have written while persistence was running.
    if (!(await projectFile(file, projected, diskHash))) {
      if (attempts >= 5)
        throw new Error(
          'The file keeps changing externally. Local history was kept; retry saving.',
        );
      return this.reconcile(session, attempts + 1);
    }
    record.base = record.pending;
    delete record.pending;
    await this.saveIndex();
  }

  async flush(urls?: readonly AutomergeUrl[]) {
    return this.run(() =>
      this.flushSessions(
        [...this.sessions.values()].filter((session) => !urls || urls.includes(session.handle.url)),
      ),
    );
  }

  private async flushSessions(sessions: readonly Session[]) {
    const failures: Error[] = [];
    const attempt = async (label: string, operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(
          new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }),
        );
      }
    };
    for (const session of sessions) {
      clearTimeout(session.timer);
      session.firstChange = undefined;
      await attempt(path.relative(this.root, session.file), () =>
        this.enqueue(session, async () => {
          try {
            await this.reconcile(session);
          } catch (projectionError) {
            // A failed disk import/export must not prevent local CRDT recovery.
            try {
              await this.persist(session.handle);
            } catch (storageError) {
              throw new AggregateError(
                [projectionError, storageError],
                `Projection and local persistence failed: ${String(projectionError)}; ${String(storageError)}`,
              );
            }
            throw projectionError;
          }
        }),
      );
    }
    await attempt('Workspace index', () => this.metadataQueue);
    await attempt('Local storage', () => this.storage.drain());
    await attempt('Pending rename', () => this.finishPendingMove());
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, failures.map((error) => error.message).join('\n'));
  }

  async rescan() {
    await this.flush();
  }

  async checkpoint() {
    return this.run(() => this.checkpointSessions());
  }

  private async checkpointSessions() {
    const failures: unknown[] = [];
    for (const session of this.sessions.values()) {
      try {
        await this.enqueue(session, () => this.persist(session.handle), false);
      } catch (error) {
        failures.push(
          new Error(`${path.relative(this.root, session.file)}: ${String(error)}`, {
            cause: error,
          }),
        );
      }
    }
    try {
      await this.saveIndex();
      await this.storage.drain();
      await this.finishPendingMove();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, failures.map(String).join('\n'));
  }

  async recoverySnapshot() {
    return [...this.sessions.values()].map((session) => ({
      path: path.relative(this.root, session.file),
      url: session.handle.url,
      heads: session.handle.heads(),
      text: session.handle.doc().content,
    }));
  }

  async awaitHeads(url: AutomergeUrl, heads: UrlHeads) {
    const handle = await this.repo.find<FileDoc>(url);
    if (A.hasHeads(handle.doc(), decodeHeads(heads))) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        handle.off('heads-changed', check);
        reject(new Error('Document synchronization timed out. Please retry.'));
      }, 10_000);
      const check = () => {
        if (A.hasHeads(handle.doc(), decodeHeads(heads))) {
          clearTimeout(timeout);
          handle.off('heads-changed', check);
          resolve();
        }
      };
      handle.on('heads-changed', check);
      check();
    });
  }

  async history(relative: string) {
    return this.run(async () => {
      const info = await this.openRecoverable(relative);
      const session = this.sessions.get(path.resolve(this.root, info.path))!;
      try {
        await this.flushSessions([session]);
      } catch {
        await this.persist(session.handle);
      }
      return (session.handle.history() ?? [])
        .slice(-100)
        .reverse()
        .map((heads) => ({
          heads,
          text: session.handle.view(heads).doc().content,
        }));
    });
  }

  async restore(relative: string, heads: UrlHeads) {
    return this.run(async () => {
      const info = await this.openRecoverable(relative);
      const session = this.sessions.get(path.resolve(this.root, info.path))!;
      const text = session.handle.view(heads).doc().content;
      session.handle.change((doc) => A.updateText(doc, ['content'], text), {
        message: 'Restore history version',
      });
      try {
        await this.flushSessions([session]);
      } catch {
        await this.persist(session.handle);
      }
    });
  }

  async rename(relative: string, target: string) {
    return this.run(async () => {
      const info = await this.openSession(relative);
      const from = path.resolve(this.root, info.path);
      const to = await this.resolveFile(target, false);
      if (from === to) return info.path;
      const session = this.sessions.get(from)!;
      const oldKey = path.relative(this.root, from);
      const key = path.relative(this.root, to);
      if (this.records[key] && this.records[key].url !== info.url)
        throw new Error('The destination already has local history. Choose another name.');
      await this.enqueue(session, async () => {
        await this.reconcile(session);
        const move = await this.moves.prepare(oldKey, key, session.record);
        try {
          await this.moves.publish(move);
        } catch (error) {
          if ((await this.moves.outcome(move)) !== 'moved') throw error;
          // The native rename may have finished before a timeout/directory sync failed.
          await syncDirectory(path.dirname(to));
          await syncDirectory(path.dirname(from));
        }
        if ((await this.moves.outcome(move)) !== 'moved')
          throw new Error('Rename did not publish the destination.');
        this.sessions.delete(from);
        session.file = to;
        this.sessions.set(to, session);
        this.records[key] = session.record;
        delete this.records[oldKey];
        this.watchSession(to);
        await this.unwatchSession(from);
        this.renameMetadata(session.handle, to);
        this.emit('status', {
          type: 'renamed',
          previousFile: oldKey,
          file: key,
        } satisfies DataEvent);
        await this.persist(session.handle);
        await this.saveIndex();
        await this.moves.clear();
      });
      return key;
    });
  }

  async close(options: { project?: boolean } = {}) {
    if (this.closed) return;
    return this.run(async () => {
      this.stopping = true;
      clearTimeout(this.evictionTimer);
      try {
        if (options.project !== false) await this.flushSessions([...this.sessions.values()]);
        else await this.checkpointSessions();
        await this.watcher.close();
        for (const session of this.sessions.values()) {
          clearTimeout(session.timer);
          session.handle.off('heads-changed', session.onHeads);
        }
        await this.repo.shutdown();
        this.closed = true;
        this.sessions.clear();
        this.sessionDirectories.clear();
        this.watchedDirectories.clear();
        this.resources.clear();
        this.resourceAliases.clear();
        await this.unlock?.();
      } finally {
        this.stopping = false;
      }
    });
  }
}
