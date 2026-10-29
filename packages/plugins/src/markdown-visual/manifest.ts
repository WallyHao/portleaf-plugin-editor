import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'markdown-visual',
  apiVersion: 1,
  requires: ['markdown'],
  commands: [
    ['markdown.toggle', 'Toggle Markdown view (Source / Live)', 'mv', 'Source / Live'],
    ['markdown.link', 'Open link under cursor', 'ml', 'Open link'],
    ['markdown.task', 'Toggle task under cursor', 'mt', 'Toggle task'],
  ].map(([id, title, keys, label]) => ({ id, title, keys, label })),
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
