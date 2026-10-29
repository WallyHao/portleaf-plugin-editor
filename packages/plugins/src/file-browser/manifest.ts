import type { Plugin } from '@portleaf/core';

export const fileBrowserKeys = [
  ['hjkl / ↵', 'Navigate'],
  ['n', 'New file'],
  ['r', 'Rename file'],
  ['c', 'Copy file'],
  ['H', 'History'],
  ['m', 'New folder'],
  ['/', 'Search'],
  ['gg / G', 'First / last'],
  ['q / Esc', 'Close'],
] as const;
export const manifest = {
  id: 'file-browser',
  apiVersion: 1,
  commands: [
    ...[
      ['files.open', 'Open file selector', 'ff', 'Files'],
      ['files.create', 'New file', 'fn', 'New file'],
      ['files.rename', 'Rename file', 'fr', 'Rename'],
      ['files.copy', 'Copy to new file', 'fc', 'Copy'],
    ].map(([id, title, keys, label]) => ({ id, title, keys, label })),
    { id: 'files.mkdir', title: 'New directory', hidden: true },
  ],
  shortcuts: fileBrowserKeys.map(([keys, title]) => ({
    scope: 'Files',
    keys,
    title,
    command: keys === 'H' ? 'history.open' : 'files.open',
  })),
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
