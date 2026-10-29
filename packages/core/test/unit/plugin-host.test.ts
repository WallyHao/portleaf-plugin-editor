// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { PluginHost, commands } from '../../src/plugin-host.js';
import { minimalPalette } from '../../src/appearance.js';
import type { Buffer, DesktopAPI, Plugin, PluginContext, Settings } from '../../src/types.js';

const settings: Settings = {
  plugins: [],
  theme: 'test',
  fontFamily: 'monospace',
  fontSize: 18,
  markdownMode: 'live',
  themeData: minimalPalette,
};
const theme: Plugin = {
  id: 'test-theme',
  apiVersion: 1,
  theme: { name: 'test', palette: () => minimalPalette },
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run());
  document.body.replaceChildren();
});
function fixture(plugins: Plugin[], files = {} as DesktopAPI) {
  const root = document.createElement('main'),
    status = document.createElement('footer');
  document.body.append(root);
  root.append(status);
  let active: Buffer | undefined;
  const report = vi.fn();
  const host = new PluginHost([...plugins, theme], {
    root,
    status,
    report,
    files,
    buffers: {
      active: () => active,
      list: () => (active ? [active] : []),
      activate: (buffer) => {
        active = buffer;
      },
      open: async () => {},
      close: async () => {},
      rename: async (_file, target) => target,
      flush: async () => {},
      subscribe: () => () => {},
    },
    quit: async () => {},
    setTheme: async () => {},
  });
  cleanup.push(() => host.destroy());
  function editor() {
    let view: EditorView;
    const buffer: Buffer = {
      get view() {
        return view;
      },
      resource: () => undefined,
      setMode() {},
    };
    const binding = host.createBuffer(buffer);
    view = new EditorView({
      parent: root,
      state: EditorState.create({ doc: 'Original', extensions: binding.extension }),
    });
    binding.attach(view);
    active = buffer;
    const destroy = () => {
      binding.destroy();
      view.destroy();
    };
    cleanup.push(destroy);
    return { view, destroy };
  }
  return { host, root, report, editor };
}

test('rejects duplicate IDs, incompatible APIs, and broken dependency graphs before activation', () => {
  const plugin: Plugin = { id: 'sample', apiVersion: 1 };
  for (const [plugins, message] of [
    [[plugin, plugin], 'Duplicate plugin ID'],
    [[{ ...plugin, apiVersion: 2 }], 'Unsupported API version'],
    [[{ ...plugin, requires: ['missing'] }], 'Unknown plugin dependency'],
    [[{ ...plugin, requires: ['sample'] }], 'Plugin dependency cycle'],
  ] as const)
    expect(() => fixture(plugins as unknown as Plugin[])).toThrow(message);
});

test('validates command ownership, duplicate IDs, Space collisions, and executable prefixes', () => {
  const sample = (id: string, command: string, keys: string): Plugin => ({
    id,
    apiVersion: 1,
    commands: [{ id: command, title: command, keys }],
    activate(ctx) {
      ctx.registerCommand(command, () => {});
    },
  });
  for (const [plugins, message] of [
    [[sample('one', 'demo.run', 'aa'), sample('two', 'demo.run', 'bb')], 'Duplicate command ID'],
    [[sample('one', 'one.run', 'aa'), sample('two', 'two.run', 'aa')], 'Conflicting shortcuts'],
    [[sample('one', 'one.run', 'a'), sample('two', 'two.run', 'aa')], 'Conflicting shortcuts'],
    [[sample('one', 'not-namespaced', 'aa')], 'Invalid command declaration'],
  ] as const) {
    const { host } = fixture([...plugins]);
    expect(() =>
      host.configure({ ...settings, plugins: plugins.map((plugin) => plugin.id) }),
    ).toThrow(message);
  }
  const { host } = fixture([
    { id: 'missing-handler', apiVersion: 1, commands: [{ id: 'demo.run', title: 'Run' }] },
  ]);
  expect(() => host.configure({ ...settings, plugins: ['missing-handler'] })).toThrow(
    'Missing command handler',
  );
  expect(() => host.configure({ ...settings, plugins: ['unknown'] })).toThrow('Unknown plugin');
  for (const duplicate of [false, true]) {
    const { host } = fixture([
      {
        id: 'owner',
        apiVersion: 1,
        commands: [{ id: 'owner.run', title: 'Run' }],
        activate(ctx) {
          ctx.registerCommand(duplicate ? 'owner.run' : 'other.run', () => {});
          ctx.registerCommand('owner.run', () => {});
        },
      },
    ]);
    expect(() => host.configure({ ...settings, plugins: ['owner'] })).toThrow(
      duplicate ? 'Duplicate command handler' : 'Undeclared command',
    );
  }
});

test('activates dependencies once per app, executes owned handlers, and retains appearance after closing buffers', async () => {
  const activated = vi.fn(),
    disposed = vi.fn();
  const { host, root, editor } = fixture([
    {
      id: 'base',
      apiVersion: 1,
      activate: () => {
        activated();
        return disposed;
      },
    },
    {
      id: 'sample',
      apiVersion: 1,
      requires: ['base'],
      commands: [{ id: 'sample.run', title: 'Run', keys: 'xx' }],
      activate(ctx) {
        ctx.registerCommand('sample.run', () => {
          ctx.buffers.active()?.view?.dispatch({ changes: { from: 0, insert: 'Changed ' } });
        });
      },
    },
  ]);
  host.configure({ ...settings, plugins: ['sample'] });
  const first = editor(),
    second = editor();
  await second.view.state.facet(commands)[0].run();
  expect(second.view.state.doc.toString()).toBe('Changed Original');
  expect(first.view.state.doc.toString()).toBe('Original');
  host.configure({ ...settings, plugins: ['sample'], fontSize: 20 });
  expect(activated).toHaveBeenCalledTimes(1);
  second.destroy();
  first.destroy();
  expect(disposed).not.toHaveBeenCalled();
  expect(root.style.getPropertyValue('--background')).toBe('#171a1b');
  expect(root.style.getPropertyValue('--font-size')).toBe('20pt');
  host.configure(settings);
  expect(disposed).toHaveBeenCalledTimes(1);
  await expect(host.execute('sample.run')).rejects.toThrow('unavailable');
});

test('rolls back failed activation and extension preparation while retaining the previous command and editor', async () => {
  const run = vi.fn(),
    dispose = vi.fn();
  const good: Plugin = {
    id: 'good',
    apiVersion: 1,
    commands: [{ id: 'good.run', title: 'Good' }],
    activate(ctx) {
      ctx.registerCommand('good.run', run);
    },
  };
  const broken: Plugin = {
    id: 'broken',
    apiVersion: 1,
    activate(ctx) {
      const element = document.createElement('aside');
      ctx.root.append(element);
      ctx.onDispose(() => {
        element.remove();
        dispose();
      });
    },
    extension() {
      throw new Error('Broken extension');
    },
  };
  const { host, editor, root } = fixture([good, broken]);
  host.configure({ ...settings, plugins: ['good'] });
  const { view } = editor();
  const previous = view.state;
  expect(() => host.configure({ ...settings, plugins: ['broken'] })).toThrow('Broken extension');
  expect(root.querySelector('aside')).toBeNull();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(view.state).toBe(previous);
  expect(host.settings.plugins).toEqual(['good']);
  await host.execute('good.run');
  expect(run).toHaveBeenCalledTimes(1);
});

test('owns picker scopes and cleanup across disable and reenable without closing another plugin panel', async () => {
  const plugin = (id: string): Plugin => ({
    id,
    apiVersion: 1,
    commands: [{ id: `${id}.open`, title: id }],
    activate(ctx) {
      ctx.registerCommand(`${id}.open`, () => ctx.picker.prompt(id, '', async () => {}));
    },
  });
  const { host, root } = fixture([plugin('one'), plugin('two')]);
  host.configure({ ...settings, plugins: ['one', 'two'] });
  await host.execute('two.open');
  host.configure({ ...settings, plugins: ['two'] });
  expect(root.querySelector<HTMLElement>('[role="dialog"]')?.hidden).toBe(false);
  host.configure(settings);
  expect(root.querySelector<HTMLElement>('[role="dialog"]')?.hidden).toBe(true);
  host.configure({ ...settings, plugins: ['one'] });
  await host.execute('one.open');
  expect(root.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(root.querySelector('.picker-label')?.textContent).toBe('one');
});

test('loads enabled implementations once, shares concurrent preparation, and retries failed imports', async () => {
  const run = vi.fn();
  const load = vi.fn(async () => ({
    activate(ctx: import('../../src/types.js').PluginContext) {
      ctx.registerCommand('lazy.run', run);
    },
  }));
  const disabled = vi.fn(async () => ({}));
  const retry = vi.fn().mockRejectedValueOnce(new Error('Import failed')).mockResolvedValue({});
  const { host } = fixture([
    { id: 'lazy', apiVersion: 1, commands: [{ id: 'lazy.run', title: 'Lazy' }], load },
    { id: 'disabled', apiVersion: 1, load: disabled },
    { id: 'retry', apiVersion: 1, load: retry },
  ]);
  host.configure(settings);
  const next = { ...settings, plugins: ['lazy'] };
  expect(() => host.configure(next)).toThrow('not prepared');
  await Promise.all([host.prepare(next), host.prepare(next)]);
  host.configure(next);
  await host.execute('lazy.run');
  expect(run).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  expect(disabled).not.toHaveBeenCalled();
  await expect(host.prepare({ ...settings, plugins: ['retry'] })).rejects.toThrow('Import failed');
  expect(host.settings.plugins).toEqual(['lazy']);
  await host.prepare({ ...settings, plugins: ['retry'] });
  expect(retry).toHaveBeenCalledTimes(2);
});

test('file browsing contributions apply to existing plugin services and disappear when disabled', async () => {
  let context: PluginContext;
  const list = vi.fn(async () => []),
    browse = vi.fn(async () => []);
  const { host } = fixture(
    [
      {
        id: 'browser',
        apiVersion: 1,
        activate(ctx) {
          context = ctx;
        },
      },
      { id: 'text-provider', apiVersion: 1, fileBrowsing: { text: true } },
    ],
    { list, browse } as unknown as DesktopAPI,
  );
  host.configure({ ...settings, plugins: ['browser'] });
  await context!.files.browse('.');
  expect(browse).toHaveBeenLastCalledWith('.', { text: false });
  host.configure({ ...settings, plugins: ['browser', 'text-provider'] });
  await context!.files.list('nested');
  expect(list).toHaveBeenLastCalledWith('nested', { text: true });
  host.configure({ ...settings, plugins: ['browser'] });
  await context!.files.browse('.');
  expect(browse).toHaveBeenLastCalledWith('.', { text: false });
});

test('file viewers contribute formats only while enabled and conflicting providers fail before activation', () => {
  const createView = vi.fn(() => ({ focus() {}, setActive() {}, destroy() {} }));
  const provider: Plugin = {
    id: 'viewer',
    apiVersion: 1,
    fileViewer: { extensions: ['pdf', 'png'] },
    createView,
  };
  const { host } = fixture([provider, { ...provider, id: 'other' }]);
  host.configure(settings);
  expect(host.viewerFor('image.PNG')).toBeUndefined();
  host.configure({ ...settings, plugins: ['viewer'] });
  expect(host.fileBrowsing.extensions).toEqual(['pdf', 'png']);
  expect(host.viewerFor('image.PNG')).toBe('viewer');
  host.createFileView('viewer', {
    parent: document.createElement('div'),
    file: { path: 'image.png', size: 1, modifiedAt: 1, deleted: false, readOnly: true },
    resource: () => 'resource',
    setStatus() {},
  });
  expect(createView).toHaveBeenCalledTimes(1);
  expect(() => host.configure({ ...settings, plugins: ['viewer', 'other'] })).toThrow(
    'conflicting viewer extension',
  );
  expect(host.viewerFor('image.png')).toBe('viewer');
  host.configure(settings);
  expect(host.fileBrowsing.extensions).toBeUndefined();
  expect(() => host.createFileView('viewer', {} as never)).toThrow('unavailable');
});
