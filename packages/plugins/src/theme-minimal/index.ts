import { manifest } from './manifest.js';
import type { Plugin } from '@portleaf/core';
import { minimalPalette } from '@portleaf/core/appearance';
import { editorTheme } from '../shared/theme.js';

export const minimalTheme: Plugin = {
  ...manifest,
  extension: () => editorTheme(minimalPalette),
};
