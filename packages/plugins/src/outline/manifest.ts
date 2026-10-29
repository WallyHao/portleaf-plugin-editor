import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'outline',
  apiVersion: 1,
  commands: [{ id: 'outline.open', title: 'Open document outline', label: 'Outline', keys: 'mo' }],
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
