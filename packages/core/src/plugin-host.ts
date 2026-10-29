import { Compartment, Facet, type Extension, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { applyAppearance, minimalPalette } from './appearance.js';
import { createPicker } from './ui/picker.js';
import type {
  Buffer,
  Command,
  CommandHandler,
  CommandSpec,
  CommandTarget,
  Dispose,
  FileBrowseOptions,
  FileViewContext,
  Plugin,
  PluginContext,
  PluginServices,
  Settings,
} from './types.js';
import { focusBuffer } from './types.js';

export const commands = Facet.define<Command>();
export const describeKeys = (keys: string) =>
  ['Space', ...Array.from(keys, (key) => (key === ' ' ? 'Space' : key))].join(' ');

type Instance = { context: PluginContext; handlers: Map<string, CommandHandler>; dispose: Dispose };
type Binding = {
  buffer: Buffer;
  slots: Map<string, Compartment>;
  commandSlot: Compartment;
  view?: EditorView;
};

export class PluginHost {
  private definitions = new Map<string, Plugin>();
  private instances = new Map<string, Instance>();
  private bindings = new Set<Binding>();
  private registry = new Map<string, Command>();
  private configured!: Settings;
  private pending?: Settings;
  private picker;
  private disposed = false;
  private implementations = new Map<
    string,
    Pick<Plugin, 'activate' | 'extension' | 'createView'>
  >();
  private loading = new Map<string, Promise<void>>();

  constructor(
    private plugins: readonly Plugin[],
    private services: PluginServices,
  ) {
    for (const plugin of plugins) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.id)) throw new Error(`Invalid plugin ID: ${plugin.id}`);
      if (this.definitions.has(plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}`);
      if (plugin.apiVersion !== 1) throw new Error(`Unsupported API version: ${plugin.id}`);
      if (plugin.theme && !/^[a-z][a-z0-9-]*$/.test(plugin.theme.name))
        throw new Error(`Invalid theme name: ${plugin.theme.name}`);
      this.definitions.set(plugin.id, plugin);
    }
    // Check even inactive definitions, so a broken catalog cannot hide until a later activation.
    const visit = (id: string, ancestors: string[] = []) => {
      const plugin = this.definitions.get(id);
      if (!plugin) throw new Error(`Unknown plugin dependency: ${id}`);
      if (ancestors.includes(id))
        throw new Error(`Plugin dependency cycle: ${[...ancestors, id].join(' -> ')}`);
      for (const dependency of plugin.requires ?? []) visit(dependency, [...ancestors, id]);
    };
    for (const plugin of plugins) visit(plugin.id);
    const themes = plugins.flatMap((plugin) => (plugin.theme ? [plugin.theme.name] : []));
    if (new Set(themes).size !== themes.length) throw new Error('Duplicate theme name.');
    this.picker = createPicker(
      services.root,
      () => focusBuffer(services.buffers.active()),
      services.report,
    );
  }

  get settings() {
    return this.configured;
  }
  get fileBrowsing(): FileBrowseOptions {
    const extensions = [
      ...new Set(
        this.plugins
          .filter((plugin) => this.instances.has(plugin.id))
          .flatMap(
            (plugin) => plugin.fileViewer?.extensions ?? plugin.fileBrowsing?.extensions ?? [],
          ),
      ),
    ];
    const excludedExtensions = [
      ...new Set(this.plugins.flatMap((plugin) => plugin.fileViewer?.extensions ?? [])),
    ].filter((extension) => !extensions.includes(extension));
    return {
      text: this.plugins.some(
        (plugin) => this.instances.has(plugin.id) && plugin.fileBrowsing?.text,
      ),
      ...(extensions.length ? { extensions } : {}),
      ...(excludedExtensions.length ? { excludedExtensions } : {}),
    };
  }
  viewerFor(file: string, enabledOnly = true): string | undefined {
    const extension = file.split('.').at(-1)?.toLowerCase();
    return this.plugins.find(
      (plugin) =>
        (!enabledOnly || this.instances.has(plugin.id)) &&
        plugin.fileViewer?.extensions.includes(extension ?? ''),
    )?.id;
  }
  hasViewer(id: string) {
    return this.instances.has(id) && !!this.definitions.get(id)?.fileViewer;
  }
  createFileView(id: string, context: Omit<FileViewContext, 'app'>) {
    const instance = this.instances.get(id);
    const definition = this.definitions.get(id);
    const implementation = this.implementations.get(id) ?? definition;
    if (!instance || !definition?.fileViewer || !implementation?.createView)
      throw new Error(`File viewer is unavailable: ${id}`);
    return implementation.createView({ ...context, app: instance.context });
  }
  get commandList(): readonly Command[] {
    return [...this.registry.values()].filter((command) => !command.hidden);
  }
  get themeNames(): readonly string[] {
    return this.plugins.flatMap((plugin) => (plugin.theme ? [plugin.theme.name] : []));
  }
  async execute(id: string, target?: CommandTarget) {
    const command = this.registry.get(id);
    if (!command) throw new Error(`Command is unavailable: ${id}`);
    await command.run(target);
  }

  private enabled(settings: Settings) {
    const theme = this.plugins.find((plugin) => plugin.theme?.name === settings.theme);
    if (!theme) throw new Error(`Unknown theme: ${settings.theme}`);
    const active = new Set<string>();
    const enable = (id: string) => {
      const plugin = this.definitions.get(id);
      if (!plugin) throw new Error(`Unknown plugin: ${id}`);
      if (plugin.theme && plugin !== theme)
        throw new Error(`Only the selected theme can be enabled: ${id}`);
      if (active.has(id)) return;
      for (const dependency of plugin.requires ?? []) enable(dependency);
      active.add(id);
    };
    for (const id of settings.plugins) {
      if (this.definitions.get(id)?.theme)
        throw new Error(`Select appearance with the theme setting: ${id}`);
      enable(id);
    }
    enable(theme.id);
    return active;
  }

  async prepare(settings: Settings) {
    await Promise.all(
      [...this.enabled(settings)].map(async (id) => {
        const plugin = this.definitions.get(id)!;
        if (!plugin.load || this.implementations.has(id)) return;
        let pending = this.loading.get(id);
        if (!pending) {
          pending = plugin
            .load()
            .then((implementation) => {
              this.implementations.set(id, implementation);
            })
            .finally(() => this.loading.delete(id));
          this.loading.set(id, pending);
        }
        await pending;
      }),
    );
  }

  private activate(plugin: Plugin): Instance {
    const cleanups: Dispose[] = [];
    const handlers = new Map<string, CommandHandler>();
    const controller = new AbortController();
    const panel = this.picker.scope();
    cleanups.push(panel.destroy);
    const host = this;
    const context: PluginContext = {
      ...this.services,
      files: {
        ...this.services.files,
        list: (directory, options) =>
          this.services.files.list(directory, options ?? this.fileBrowsing),
        browse: (directory, options) =>
          this.services.files.browse(directory, options ?? this.fileBrowsing),
      },
      get settings() {
        return host.pending ?? host.configured;
      },
      get fileBrowsing() {
        return host.fileBrowsing;
      },
      signal: controller.signal,
      picker: panel.picker,
      commands: {
        list: () => this.commandList,
        has: (id) => this.registry.has(id),
        execute: async (id, target) => {
          if (controller.signal.aborted) throw new Error(`Plugin is disabled: ${plugin.id}`);
          await this.execute(id, target);
        },
      },
      themes: () => this.themeNames,
      shortcuts: () =>
        this.plugins
          .filter((item) => this.instances.has(item.id))
          .flatMap((item) => item.shortcuts ?? []),
      registerCommand: (id, handler) => {
        if (controller.signal.aborted) throw new Error(`Plugin is disabled: ${plugin.id}`);
        if (!plugin.commands?.some((command) => command.id === id))
          throw new Error(`Undeclared command: ${plugin.id} / ${id}`);
        if (handlers.has(id)) throw new Error(`Duplicate command handler: ${id}`);
        handlers.set(id, handler);
      },
      onDispose: (dispose) => {
        if (controller.signal.aborted) dispose();
        else cleanups.push(dispose);
      },
    };
    const dispose = () => {
      controller.abort();
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch (error) {
          this.services.report(error);
        }
      }
      handlers.clear();
    };
    try {
      const cleanup = (this.implementations.get(plugin.id) ?? plugin).activate?.(context);
      if (cleanup) cleanups.push(cleanup);
      for (const command of plugin.commands ?? [])
        if (!handlers.has(command.id)) throw new Error(`Missing command handler: ${command.id}`);
      return { context, handlers, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  configure(settings: Settings) {
    if (this.disposed) throw new Error('Plugin host is disposed.');
    if (
      !Array.isArray(settings.plugins) ||
      new Set(settings.plugins).size !== settings.plugins.length
    )
      throw new Error('Plugin IDs must be a unique array.');
    if (
      !settings.fontFamily ||
      !Number.isFinite(settings.fontSize) ||
      settings.fontSize < 8 ||
      settings.fontSize > 32
    )
      throw new Error('Use a font family and a font size between 8 and 32 points.');
    const active = this.enabled(settings);
    const theme = this.plugins.find((plugin) => plugin.theme?.name === settings.theme)!;
    for (const id of active)
      if (this.definitions.get(id)!.load && !this.implementations.has(id))
        throw new Error(`Plugin is not prepared: ${id}`);
    const specs = new Map<string, CommandSpec>();
    const formats = new Set<string>();
    for (const id of active) {
      const plugin = this.definitions.get(id)!;
      if (plugin.fileViewer && !(this.implementations.get(id) ?? plugin).createView)
        throw new Error(`Missing file viewer implementation: ${id}`);
      for (const extension of plugin.fileViewer?.extensions ?? []) {
        if (!/^[a-z0-9]+$/.test(extension) || formats.has(extension))
          throw new Error(`Invalid or conflicting viewer extension: ${extension}`);
        formats.add(extension);
      }
    }
    const keys: string[] = [];
    for (const plugin of this.plugins.filter((item) => active.has(item.id))) {
      for (const command of plugin.commands ?? []) {
        if (!/^[a-z][\w-]*(?:\.[\w-]+)+$/.test(command.id) || !command.title)
          throw new Error(`Invalid command declaration: ${command.id}`);
        if (specs.has(command.id)) throw new Error(`Duplicate command ID: ${command.id}`);
        specs.set(command.id, command);
        if (command.keys !== undefined) {
          if (!/^[\x20-\x7e]+$/.test(command.keys))
            throw new Error(`Invalid Space shortcut: ${command.id}`);
          const conflict = keys.find(
            (key) => key.startsWith(command.keys!) || command.keys!.startsWith(key),
          );
          if (conflict !== undefined)
            throw new Error(
              `Conflicting shortcuts: ${describeKeys(conflict)} / ${describeKeys(command.keys)}`,
            );
          keys.push(command.keys);
        }
      }
    }
    const palette = theme.theme!.palette(settings);
    for (const name of Object.keys(minimalPalette.colors))
      if (!/^#[0-9a-f]{6}$/i.test(palette.colors[name] ?? ''))
        throw new Error(`Invalid theme color: ${settings.theme} / ${name}`);

    const next = new Map<string, Instance>();
    const staged: Instance[] = [];
    const registry = new Map<string, Command>();
    let transactions: { binding: Binding; transaction: Transaction }[];
    this.pending = settings;
    try {
      for (const id of active) {
        const instance = this.instances.get(id) ?? this.activate(this.definitions.get(id)!);
        if (!this.instances.has(id)) staged.push(instance);
        next.set(id, instance);
      }
      for (const plugin of this.plugins.filter((item) => active.has(item.id)))
        for (const spec of plugin.commands ?? [])
          registry.set(spec.id, {
            ...spec,
            run: (target) => {
              const handler = this.instances.get(plugin.id)?.handlers.get(spec.id);
              if (!handler) throw new Error(`Command is unavailable: ${spec.id}`);
              return handler(target);
            },
          });
      transactions = [...this.bindings].map((binding) => ({
        binding,
        transaction: binding.view!.state.update({
          effects: [
            binding.commandSlot.reconfigure(
              [...registry.values()]
                .filter((command) => !command.hidden)
                .map((command) =>
                  commands.of({ ...command, run: (target) => this.execute(command.id, target) }),
                ),
            ),
            ...this.plugins.map((plugin) =>
              binding.slots
                .get(plugin.id)!
                .reconfigure(this.resolve(plugin, binding.buffer, next, settings)),
            ),
          ],
        }),
      }));
    } catch (error) {
      for (const instance of staged.reverse()) instance.dispose();
      throw error;
    } finally {
      this.pending = undefined;
    }
    for (const [id, instance] of [...this.instances].reverse())
      if (!next.has(id)) instance.dispose();
    this.configured = settings;
    this.instances = next;
    this.registry = registry;
    // Application tokens belong to the host, never to the last-created buffer.
    const root = this.services.root;
    applyAppearance(root, settings, palette);
    root.dataset.plugins = [...active].join(' ');
    for (const { binding, transaction } of transactions) binding.view!.dispatch(transaction);
  }

  private resolve(
    plugin: Plugin,
    buffer: Buffer,
    instances = this.instances,
    settings = this.configured,
  ): Extension {
    const instance = instances.get(plugin.id);
    return instance
      ? ((this.implementations.get(plugin.id) ?? plugin).extension?.({
          app: instance.context,
          settings,
          buffer,
        }) ?? [])
      : [];
  }

  createBuffer(buffer: Buffer) {
    const binding: Binding = {
      buffer,
      slots: new Map(this.plugins.map((plugin) => [plugin.id, new Compartment()])),
      commandSlot: new Compartment(),
    };
    const extension: Extension = [
      binding.commandSlot.of(
        this.commandList.map((command) =>
          commands.of({ ...command, run: (target) => this.execute(command.id, target) }),
        ),
      ),
      ...this.plugins.map((plugin) =>
        binding.slots.get(plugin.id)!.of(this.resolve(plugin, buffer)),
      ),
    ];
    return {
      extension,
      attach: (view: EditorView) => {
        binding.view = view;
        this.bindings.add(binding);
      },
      destroy: () => {
        this.bindings.delete(binding);
      },
      refresh: () => {
        binding.view!.dispatch({
          effects: this.plugins.map((plugin) =>
            binding.slots.get(plugin.id)!.reconfigure(this.resolve(plugin, buffer)),
          ),
        });
      },
    };
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    for (const instance of [...this.instances.values()].reverse()) instance.dispose();
    this.instances.clear();
    this.registry.clear();
    this.bindings.clear();
    this.picker.destroy();
    for (const name of [...Object.keys(minimalPalette.colors), 'font-family', 'font-size'])
      this.services.root.style.removeProperty(`--${name}`);
    delete this.services.root.dataset.plugins;
    this.services.root.style.removeProperty('color-scheme');
  }
}
