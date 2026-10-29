import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '@portleaf/data-patchwork/storage';
import type { Settings } from '@portleaf/core';
import { minimalPalette } from '@portleaf/core/appearance';
import { isObject, parseConfiguration, type UserConfiguration } from './configuration.js';

export const configRoot =
  process.env.PORTLEAF_CONFIG_HOME ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'portleaf');
export const appearanceFile = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'folio',
  'appearance.json',
);

async function readConfiguration(): Promise<UserConfiguration> {
  try {
    return parseConfiguration(await readFile(path.join(configRoot, 'config.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {};
  }
}

export async function settings(options: { ignoreUserConfig?: boolean } = {}): Promise<Settings> {
  const config = options.ignoreUserConfig ? {} : await readConfiguration();
  let appearance: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(appearanceFile, 'utf8'));
    if (isObject(value)) appearance = value;
  } catch {
    /* Folio integration is optional. */
  }
  const colors = { ...minimalPalette.colors };
  const palette = isObject(appearance.palette) ? appearance.palette : {};
  const roles = isObject(appearance.roles) ? appearance.roles : {};
  for (const role of Object.keys(colors)) {
    const mapped = typeof roles[role] === 'string' ? roles[role] : role;
    const value = palette[mapped];
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) colors[role] = value;
  }
  const fontFamily =
    typeof appearance['font-family'] === 'string' && appearance['font-family'].trim()
      ? appearance['font-family']
      : 'monospace';
  const fontSize =
    typeof appearance['font-size'] === 'number' && Number.isFinite(appearance['font-size'])
      ? appearance['font-size']
      : 14;
  return {
    plugins: config.plugins
      ? [
          ...config.plugins,
          ...(config.pluginApiVersion === undefined &&
          config.plugins.includes('navigation') &&
          !config.plugins.includes('file-browser')
            ? ['file-browser']
            : []),
        ]
      : [
          'markdown',
          'markdown-visual',
          'markdown-html',
          'vim',
          'file-browser',
          'navigation',
          'history',
          'outline',
          'text-files',
          'media-viewer',
        ],
    pluginSettings:
      config.pluginSettings &&
      typeof config.pluginSettings === 'object' &&
      !Array.isArray(config.pluginSettings)
        ? config.pluginSettings
        : {},
    markdownMode: config.markdownMode === 'source' ? 'source' : 'live',
    theme: config.theme ?? 'folio',
    fontFamily: config.fontFamily ?? fontFamily,
    fontSize: Math.max(8, Math.min(32, config.fontSize ?? fontSize)),
    themeData: { dark: appearance.appearance !== 'light', colors },
  };
}

export async function selectTheme(theme: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(theme)) throw new Error('Invalid theme name.');
  const config = await readConfiguration();
  await atomicWrite(
    path.join(configRoot, 'config.json'),
    JSON.stringify({ ...config, theme }, null, 2) + '\n',
  );
  return settings();
}
