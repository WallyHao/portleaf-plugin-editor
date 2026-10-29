import type { Plugin } from '@portleaf/core';
import { minimalPalette } from '@portleaf/core/appearance';

export const manifest = {
  id: 'theme-minimal',
  apiVersion: 1,
  theme: { name: 'minimal', palette: () => minimalPalette },
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
