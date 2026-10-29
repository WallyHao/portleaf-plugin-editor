import { describe, expect, test } from 'vitest';
import { parseConfiguration } from '../../src/configuration.js';

describe('user configuration boundary', () => {
  test.each(['null', '[]', '42', '"text"', '{'])(
    'rejects invalid root %s with an actionable error',
    (source) => {
      expect(() => parseConfiguration(source)).toThrow('Invalid config.json:');
    },
  );

  test.each([
    { plugins: 123 },
    { plugins: 'vim' },
    { plugins: [null] },
    { plugins: ['vim', 'vim'] },
    { plugins: [''] },
    { fontFamily: [] },
    { fontFamily: '   ' },
    { fontSize: '18' },
    { fontSize: null },
    { theme: {} },
    { markdownMode: ['source'] },
    { markdownMode: 'preview' },
    { pluginSettings: [] },
    { pluginSettings: null },
    { pluginApiVersion: 2 },
  ])('rejects invalid field types in %j', (config) => {
    expect(() => parseConfiguration(JSON.stringify(config))).toThrow('Invalid config.json:');
  });

  test('rejects numeric overflow instead of allowing a non-finite font size', () => {
    expect(() => parseConfiguration('{"fontSize":1e999}')).toThrow('finite number');
  });

  test('preserves empty plugin lists, legacy migration input and unknown configuration keys', () => {
    expect(parseConfiguration('{"plugins":[]}').plugins).toEqual([]);
    const legacy = { plugins: ['navigation'], custom: { enabled: true } };
    expect(parseConfiguration(JSON.stringify(legacy))).toEqual(legacy);
    expect(parseConfiguration('{"plugins":["missing-plugin"]}').plugins).toEqual([
      'missing-plugin',
    ]);
  });

  test('accepts supported settings without discarding provider options', () => {
    const config = {
      pluginApiVersion: 1,
      plugins: ['vim', 'media-viewer'],
      pluginSettings: { 'media-viewer': { maxCanvasPixels: 1000000 } },
      markdownMode: 'source',
      theme: 'minimal',
      fontFamily: 'monospace',
      fontSize: 18,
    };
    expect(parseConfiguration(JSON.stringify(config))).toEqual(config);
  });
});
