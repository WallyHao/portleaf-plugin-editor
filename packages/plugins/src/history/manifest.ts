import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'history',
  apiVersion: 1,
  commands: [{ id: 'history.open', title: 'Document history', label: 'History', keys: 'fh' }],
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
