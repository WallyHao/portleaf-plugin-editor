import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'markdown-html',
  apiVersion: 1,
  requires: ['markdown-visual'],
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
