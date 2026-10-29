import type { Settings } from '@portleaf/core';

export type UserConfiguration = Record<string, unknown> &
  Partial<
    Pick<
      Settings,
      'plugins' | 'pluginSettings' | 'markdownMode' | 'theme' | 'fontFamily' | 'fontSize'
    >
  > & {
    pluginApiVersion?: 1;
  };

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseConfiguration(source: string): UserConfiguration {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Invalid config.json: use valid JSON.');
  }
  const invalid = (message: string): never => {
    throw new Error(`Invalid config.json: ${message}`);
  };
  if (!isObject(value)) invalid('the root must be an object.');
  const config = value as Record<string, unknown>;
  if (
    config.plugins !== undefined &&
    (!Array.isArray(config.plugins) ||
      !config.plugins.every((id) => typeof id === 'string' && id.length > 0) ||
      new Set(config.plugins).size !== config.plugins.length)
  )
    invalid('plugins must be an array of unique, nonempty strings.');
  for (const key of ['theme', 'fontFamily'] as const)
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim()))
      invalid(`${key} must be a nonempty string.`);
  if (
    config.fontSize !== undefined &&
    (typeof config.fontSize !== 'number' || !Number.isFinite(config.fontSize))
  )
    invalid('fontSize must be a finite number.');
  if (
    config.markdownMode !== undefined &&
    config.markdownMode !== 'source' &&
    config.markdownMode !== 'live'
  )
    invalid('markdownMode must be "source" or "live".');
  if (config.pluginSettings !== undefined && !isObject(config.pluginSettings))
    invalid('pluginSettings must be an object.');
  if (config.pluginApiVersion !== undefined && config.pluginApiVersion !== 1)
    invalid('pluginApiVersion must be 1.');
  return config as UserConfiguration;
}
