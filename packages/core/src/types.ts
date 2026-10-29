import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Picker } from './ui/picker.js';
import type { Theme } from './appearance.js';

export type Dispose = () => void;
export type FileBrowseOptions = {
  text?: boolean;
  extensions?: readonly string[];
  excludedExtensions?: readonly string[];
};
export type Settings = {
  plugins: string[];
  theme: string;
  fontFamily: string;
  fontSize: number;
  themeData: Theme;
  markdownMode: 'source' | 'live';
  pluginSettings?: Record<string, unknown>;
};
export type CommandSpec = {
  id: string;
  title: string;
  label?: string;
  keys?: string;
  hidden?: boolean;
};
export type CommandTarget = {
  file?: string;
  directory?: string;
  onClose?: Dispose;
  afterRun?: (file?: string) => void | Promise<void>;
};
export type CommandHandler = (target?: CommandTarget) => void | Promise<void>;
export type Command = CommandSpec & { run: CommandHandler };
export type LocalShortcut = { scope: string; keys: string; title: string; command: string };
export type CommandService = {
  list(): readonly Command[];
  has(id: string): boolean;
  execute(id: string, target?: CommandTarget): Promise<void>;
};
export type Buffer = {
  readonly info?: FileIdentity;
  readonly view?: EditorView;
  focus?(): void;
  resource(target: string): string | undefined;
  setMode(value: string): void;
};

export function focusBuffer(buffer?: Buffer) {
  if (buffer?.focus) buffer.focus();
  else buffer?.view?.focus();
}

export type FileView = {
  focus(): void;
  setActive(active: boolean): void;
  destroy(): void;
};
export type FileViewContext = {
  app: PluginContext;
  parent: HTMLElement;
  file: FileResource;
  resource(): string;
  setStatus(mode: string, detail: string): void;
};
export type BufferService = {
  active(): Buffer | undefined;
  list(): readonly Buffer[];
  open(file: string, create?: boolean, options?: { replaceActive?: boolean }): Promise<void>;
  activate(buffer: Buffer): void;
  close(): Promise<void>;
  rename(file: string, target: string): Promise<string>;
  flush(file?: string): Promise<void>;
  subscribe(listener: Dispose): Dispose;
};
export type PluginServices = {
  root: HTMLElement;
  status: HTMLElement;
  files: DesktopAPI;
  buffers: BufferService;
  report(error: unknown): void;
  quit(): Promise<void>;
  setTheme(theme: string): Promise<void>;
};
export type PluginContext = PluginServices & {
  readonly settings: Settings;
  readonly fileBrowsing: FileBrowseOptions;
  readonly signal: AbortSignal;
  readonly picker: Picker;
  commands: CommandService;
  themes(): readonly string[];
  shortcuts(): readonly LocalShortcut[];
  registerCommand(id: string, handler: CommandHandler): void;
  onDispose(dispose: Dispose): void;
};
export type BufferContext = {
  app: PluginContext;
  settings: Settings;
  buffer: Buffer;
};

// Declarations are checked before activation. Buffer behavior remains native CodeMirror.
export type Plugin = {
  id: string;
  apiVersion: 1;
  requires?: readonly string[];
  fileBrowsing?: FileBrowseOptions;
  fileViewer?: { extensions: readonly string[] };
  commands?: readonly CommandSpec[];
  shortcuts?: readonly LocalShortcut[];
  theme?: { name: string; palette(settings: Settings): Theme };
  load?(): Promise<Pick<Plugin, 'activate' | 'extension' | 'createView'>>;
  activate?(context: PluginContext): void | Dispose;
  extension?(context: BufferContext): Extension;
  createView?(context: FileViewContext): FileView;
};

export type Bootstrap = {
  root: string;
  initialFile?: string;
  settings: Settings;
  configurationError?: string;
};
export type FileIdentity = { path: string; url?: string; deleted: boolean; readOnly: boolean };
export type OpenFile = FileIdentity & { url: string };
export type FileResource = FileIdentity & { size: number; modifiedAt: number };
export type Version = { heads: string[]; text: string };
export type FileEntry = { name: string; path: string; directory: boolean; deleted?: boolean };
export type RecoveryDocument = { path: string; url?: string; heads?: string[]; text: string };
export type WorkspaceMetrics = {
  sessions: number;
  activeSessions: number;
  failedSessions: number;
  cachedDocuments: number;
  directoryWatches: number;
  browsedDirectories: number;
  resourceReferences: number;
  watcherResets: number;
};
export type DesktopAPI = {
  bootstrap(): Promise<Bootstrap>;
  connect(): void;
  list(directory?: string, options?: FileBrowseOptions): Promise<string[]>;
  browse(directory: string, options?: FileBrowseOptions): Promise<FileEntry[]>;
  preview(file: string): Promise<string>;
  inspect(file: string): Promise<FileResource>;
  watchResource(file: string, enabled: boolean): Promise<void>;
  mkdir(directory: string): Promise<string>;
  copy(file: string, target: string): Promise<OpenFile>;
  open(file: string): Promise<OpenFile>;
  create(file: string, retain?: boolean): Promise<OpenFile>;
  release(file: string, heads: string[], url?: string): Promise<{ warning?: string }>;
  diagnostics(): Promise<WorkspaceMetrics>;
  saveRecovery(documents: RecoveryDocument[]): Promise<string>;
  restart(documents: RecoveryDocument[]): Promise<void>;
  rename(file: string, target: string): Promise<string>;
  openLink(file: string, target: string): Promise<{ path: string; fragment: string } | null>;
  flush(documents: { url: string; heads: string[] }[]): Promise<void>;
  history(file: string): Promise<Version[]>;
  restore(file: string, heads: string[]): Promise<void>;
  setTheme(theme: string): Promise<Settings>;
  quit(documents?: RecoveryDocument[]): Promise<boolean>;
  onEvent(
    callback: (event: {
      type: string;
      file?: string;
      previousFile?: string;
      message?: string;
      readOnly?: boolean;
      settings?: Settings;
    }) => void,
  ): Dispose;
};
