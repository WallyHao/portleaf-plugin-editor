import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'text-files',
  apiVersion: 1,
  fileBrowsing: { text: true },
  commands: [
    { id: 'text.open', title: 'Open text file by path', label: 'Open path', keys: 'ft' },
    { id: 'text.create', title: 'New text file (exact name)', label: 'New text file' },
    { id: 'text.language', title: 'Select file language', label: 'Language', keys: 'ul' },
  ],
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
