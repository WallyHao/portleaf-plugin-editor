import { manifest } from './manifest.js';
import { describeKeys, type Plugin } from '@portleaf/core';

export const navigationPlugin: Plugin = {
  ...manifest,
  activate(context) {
    const { buffers, picker } = context;
    context.registerCommand('buffers.open', () =>
      picker.show(
        'Switch buffer',
        buffers.list().map((buffer) => ({
          label: buffer.info!.path,
          run: () => buffers.activate(buffer),
        })),
      ),
    );
    for (const [id, direction] of [
      ['buffers.next', 1],
      ['buffers.previous', -1],
    ] as const)
      context.registerCommand(id, () => {
        const list = buffers.list(),
          current = buffers.active();
        if (list.length)
          buffers.activate(list[(list.indexOf(current!) + direction + list.length) % list.length]);
      });
    context.registerCommand('buffers.close', buffers.close);
    for (const id of ['commands.open', 'keys.show'])
      context.registerCommand(id, () =>
        picker.show(id === 'keys.show' ? 'Keyboard shortcuts' : 'Commands', [
          ...context.commands.list().map((command) => ({
            label: command.title,
            display: command.label,
            detail: command.keys ? describeKeys(command.keys) : '',
            run: () => context.commands.execute(command.id),
          })),
          ...(id === 'keys.show'
            ? context
                .shortcuts()
                .filter((key) => context.commands.has(key.command))
                .map((key) => ({
                  label: `${key.scope}: ${key.title}`,
                  detail: key.keys,
                  run: () => context.commands.execute(key.command),
                }))
            : []),
        ]),
      );
    context.registerCommand('theme.select', () =>
      picker.show(
        'Select theme',
        context.themes().map((theme) => ({
          label: theme,
          run: () => context.setTheme(theme),
        })),
      ),
    );
    context.registerCommand('app.quit', context.quit);
  },
};
