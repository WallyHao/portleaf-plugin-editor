import type { CommandService } from '../types.js';
import { pageDirection, renderKeyHints, shortcutPageSize } from './key-hints.js';

// Non-text views share the command registry without depending on the Vim engine.
export function createCommandKeys(
  parent: HTMLElement,
  commands: CommandService,
  report: (error: unknown) => void,
) {
  const hint = document.createElement('div');
  hint.className = 'view-command-hint picker';
  hint.setAttribute('aria-label', 'Shortcut hints');
  hint.hidden = true;
  parent.append(hint);
  let prefix: string | undefined;
  let page = 0;
  let timer: ReturnType<typeof setTimeout>;
  const cancel = () => {
    prefix = undefined;
    hint.hidden = true;
    clearTimeout(timer);
  };
  function render() {
    const matches = commands.list().filter((command) => command.keys?.startsWith(prefix ?? ''));
    const pages = Math.max(1, Math.ceil(matches.length / shortcutPageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    renderKeyHints(
      hint,
      matches
        .slice(page * shortcutPageSize, (page + 1) * shortcutPageSize)
        .map((command) => [
          `Space ${Array.from(command.keys!, (key) => (key === ' ' ? 'Space' : key)).join(' ')}`,
          command.label ?? command.title,
        ]),
    );
    hint.hidden = false;
  }
  return {
    handle(event: KeyboardEvent) {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (prefix === undefined) {
        if (event.key !== ' ') return false;
        prefix = '';
        page = 0;
      } else {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
          return true;
        }
        const direction = pageDirection(event);
        if (direction) {
          event.preventDefault();
          page += direction;
          render();
          return true;
        }
        if (event.key.length !== 1) {
          cancel();
          return false;
        }
        prefix += event.key;
        const command = commands.list().find((command) => command.keys === prefix);
        if (command) {
          event.preventDefault();
          cancel();
          void commands.execute(command.id).catch(report);
          return true;
        }
        if (!commands.list().some((command) => command.keys?.startsWith(prefix!))) {
          event.preventDefault();
          cancel();
          return true;
        }
      }
      event.preventDefault();
      render();
      clearTimeout(timer);
      timer = setTimeout(cancel, 3000);
      return true;
    },
    cancel,
    destroy() {
      cancel();
      hint.remove();
    },
  };
}
