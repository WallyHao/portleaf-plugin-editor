import type { Plugin } from '@portleaf/core';

export const manifest = {
  id: 'navigation',
  apiVersion: 1,
  commands: [
    ['buffers.open', 'Switch buffer', 'bb', 'Buffers'],
    ['buffers.next', 'Next buffer', 'bn', 'Next buffer'],
    ['buffers.previous', 'Previous buffer', 'bp', 'Prev buffer'],
    ['buffers.close', 'Close buffer', 'bd', 'Close buffer'],
    ['commands.open', 'Commands', ' ', 'Commands'],
    ['keys.show', 'Keyboard shortcuts', '?', 'Shortcuts'],
    ['theme.select', 'Select theme', 'ut', 'Theme'],
    ['app.quit', 'Quit', 'qq', 'Quit'],
  ].map(([id, title, keys, label]) => ({ id, title, keys, label })),
} satisfies Omit<Plugin, 'activate' | 'extension' | 'load'>;
