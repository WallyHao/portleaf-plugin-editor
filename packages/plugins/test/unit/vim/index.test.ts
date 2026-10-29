// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { getCM, Vim } from '@replit/codemirror-vim';
import {
  PluginHost,
  minimalPalette,
  type Plugin,
  type Settings,
  type Buffer,
  type DesktopAPI,
} from '@portleaf/core';
import { vimPlugin } from '../../../src/vim/index.js';
import { navigationPlugin } from '../../../src/navigation/index.js';

afterEach(() => document.body.replaceChildren());
test('a plugin callback runs from real Vim Space mappings and the palette, including after reassignment', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const root = document.createElement('main');
  document.body.append(root);
  const run = vi.fn(),
    replacement = vi.fn(),
    report = vi.fn();
  const commandPlugin = (id: string, handler: () => void): Plugin => ({
    id,
    apiVersion: 1,
    commands: [{ id: `${id}.run`, title: 'Custom command', keys: 'xx' }],
    activate(ctx) {
      ctx.registerCommand(`${id}.run`, handler);
    },
  });
  let view: EditorView;
  const buffer: Buffer = {
    get view() {
      return view;
    },
    resource: () => undefined,
    setMode() {},
  };
  const host = new PluginHost(
    [
      commandPlugin('sample', run),
      commandPlugin('replacement', replacement),
      vimPlugin,
      navigationPlugin,
      { id: 'test-theme', apiVersion: 1, theme: { name: 'test', palette: () => minimalPalette } },
    ],
    {
      root,
      status: root,
      files: {} as DesktopAPI,
      report,
      buffers: {
        active: () => buffer,
        list: () => [buffer],
        activate() {},
        open: async () => {},
        close: async () => {},
        rename: async (_file, target) => target,
        flush: async () => {},
        subscribe: () => () => {},
      },
      quit: async () => {},
      setTheme: async () => {},
    },
  );
  const settings: Settings = {
    plugins: ['sample', 'vim', 'navigation'],
    theme: 'test',
    themeData: minimalPalette,
    fontFamily: 'monospace',
    fontSize: 18,
    markdownMode: 'live',
  };
  host.configure(settings);
  const binding = host.createBuffer(buffer);
  view = new EditorView({ parent: root, extensions: binding.extension });
  binding.attach(view);
  try {
    const press = (...keys: string[]) =>
      keys.forEach((key) => Vim.handleKey(getCM(view)!, key, 'user'));
    press('<Space>', 'x', 'x');
    expect(run).toHaveBeenCalledTimes(1);
    press('<Space>', '<Space>');
    const choice = root.querySelector<HTMLButtonElement>('[title="Custom command"]')!;
    expect(choice).not.toBeNull();
    choice.click();
    expect(run).toHaveBeenCalledTimes(2);
    host.configure({ ...settings, plugins: ['replacement', 'vim', 'navigation'] });
    press('<Space>', 'x', 'x');
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report).not.toHaveBeenCalled();
  } finally {
    binding.destroy();
    view.destroy();
    host.destroy();
  }
});
