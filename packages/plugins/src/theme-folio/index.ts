import { manifest } from './manifest.js';
import type { Plugin } from '@portleaf/core';
import { editorTheme } from '../shared/theme.js';

export const folioTheme: Plugin = {
  ...manifest,
  extension: ({ settings }) => editorTheme(settings.themeData),
};
