import { manifest } from './manifest.js';
import type { Plugin } from '@portleaf/core';

export const historyPlugin: Plugin = {
  ...manifest,
  activate(context) {
    context.registerCommand('history.open', async (target) => {
      const file = target ? target.file : context.buffers.active()?.info?.path;
      if (!file) throw new Error('Select a Markdown file.');
      if (context.fileBrowsing.extensions?.includes(file.split('.').at(-1)?.toLowerCase() ?? ''))
        throw new Error('History is available for text documents.');
      await context.buffers.flush(file);
      const versions = await context.files.history(file);
      context.picker.show(
        `History · ${file.split('/').at(-1)}`,
        versions.map((version, index) => ({
          label: index === 0 ? 'Current version' : `Version ${versions.length - index}`,
          detail: version.heads[0]?.slice(0, 10),
          preview: version.text,
          run: async () => {
            await context.files.restore(file, version.heads);
            await target?.afterRun?.();
          },
        })),
        target?.onClose,
      );
    });
  },
};
