import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'markdown',
  apiVersion: 1,
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
