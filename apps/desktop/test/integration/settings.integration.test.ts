import { test as base, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const test = base.extend<{
  configuration: { directory: string; file: string; api: typeof import('../../src/settings.js') };
}>({
  configuration: async ({}, use) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-settings-'));
    try {
      vi.stubEnv('PORTLEAF_CONFIG_HOME', directory);
      vi.stubEnv('XDG_CONFIG_HOME', directory);
      vi.resetModules();
      const api = await import('../../src/settings.js');
      await use({ directory, file: path.join(directory, 'config.json'), api });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('ignores malformed optional appearance values and returns usable defaults', async ({
  configuration,
}) => {
  const { directory, api } = configuration;
  await mkdir(path.join(directory, 'folio'));
  for (const appearance of [
    null,
    [],
    { palette: [], roles: 12, 'font-family': {}, 'font-size': 'big' },
  ]) {
    await writeFile(api.appearanceFile, JSON.stringify(appearance));
    const settings = await api.settings();
    expect(settings.fontFamily).toBe('monospace');
    expect(settings.fontSize).toBe(14);
    expect(settings.themeData.colors.foreground).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test('refuses theme writes over invalid user configuration and leaves the bytes intact', async ({
  configuration,
}) => {
  const { file, api } = configuration;
  await writeFile(file, '{"plugins":123,"custom":"keep me"}');
  const original = await readFile(file);
  await expect(api.selectTheme('minimal')).rejects.toThrow('Invalid config.json:');
  expect(await readFile(file)).toEqual(original);
  const defaults = await api.settings({ ignoreUserConfig: true });
  expect(defaults.plugins).toContain('vim');
  expect(defaults.theme).toBe('folio');
});

test('theme updates retain provider preferences and future configuration keys', async ({
  configuration,
}) => {
  const { file, api } = configuration;
  const config = {
    plugins: [],
    theme: 'folio',
    pluginSettings: { 'media-viewer': { zoomStep: 1.4 } },
    future: { enabled: true },
  };
  await writeFile(file, JSON.stringify(config));
  expect((await api.selectTheme('minimal')).plugins).toEqual([]);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...config, theme: 'minimal' });
});
