import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'theme-folio',
  apiVersion: 1,
  theme: { name: 'folio', palette: (settings) => settings.themeData },
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
