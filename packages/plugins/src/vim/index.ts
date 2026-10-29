import { manifest } from './manifest.js';
import { ViewPlugin, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { vim, Vim, getCM } from '@replit/codemirror-vim';
import {
  commands,
  describeKeys,
  pageDirection,
  renderKeyHints,
  shortcutPageSize,
  type Plugin,
  type BufferContext,
} from '@portleaf/core';
import './style.css';

const contexts = new WeakMap<EditorView, BufferContext>();
const paging = new WeakMap<EditorView, (event: KeyboardEvent) => boolean>();
const mapped = new Map<string, Set<EditorView>>();
const sequence = (keys: string) => '<Space>' + keys.replaceAll(' ', '<Space>');
let views = 0;
let adapterInstalled = false;
function installAdapter() {
  if (!adapterInstalled) {
    // Upstream exposes no undefine API. These process-wide delegates retain no app resources.
    for (const name of ['write', 'quit', 'wq']) {
      Vim.defineEx(name, name === 'write' ? 'w' : name === 'quit' ? 'q' : undefined, (cm) => {
        const ctx = contexts.get(cm.cm6)?.app;
        if (ctx) void (name === 'write' ? ctx.buffers.flush() : ctx.quit()).catch(ctx.report);
      });
    }
    Vim.defineAction('portleafCommand', (cm, args) => {
      const view = cm.cm6 as EditorView;
      const { keys } = args as typeof args & { keys: string };
      const command = view.state.facet(commands).find((item) => item.keys === keys);
      const ctx = contexts.get(view)?.app;
      if (command && ctx) void ctx.commands.execute(command.id).catch(ctx.report);
    });
    adapterInstalled = true;
  }
  if (views++ === 0) {
    // Remove the built-in single-Space motion so it cannot preempt leader prefixes.
    // @ts-expect-error Upstream requires a context in its type but accepts an omitted one.
    Vim.unmap('<Space>');
  }
}

export const vimPlugin: Plugin = {
  ...manifest,
  extension: (context) => [
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => paging.get(view)?.(event) ?? false,
      }),
    ),
    Prec.high(vim()),
    ViewPlugin.define((view) => {
      installAdapter();
      contexts.set(view, context);
      const cm = getCM(view);
      const hint = document.createElement('div');
      hint.className = 'leader-hint';
      hint.hidden = true;
      hint.setAttribute('role', 'region');
      hint.setAttribute('aria-label', 'Shortcut hints');
      hint.innerHTML =
        '<div class="picker-heading"><span class="picker-label"></span><span class="picker-page" aria-live="polite"></span></div><div class="leader-choices"></div><div class="leader-paging"></div>';
      const heading = hint.querySelector<HTMLElement>('.picker-label')!;
      const pageStatus = hint.querySelector<HTMLElement>('.picker-page')!;
      const choices = hint.querySelector<HTMLElement>('.leader-choices')!;
      let prefix = '',
        page = 0;
      renderKeyHints(hint.querySelector<HTMLElement>('.leader-paging')!, [
        ['Tab', 'Next page'],
        ['Shift+Tab', 'Prev page'],
      ]);
      view.dom.append(hint);
      const register = () => {
        const keys = new Set(
          view.state.facet(commands).flatMap((command) => (command.keys ? [command.keys] : [])),
        );
        for (const [key, users] of mapped) {
          if (!keys.has(key)) users.delete(view);
          if (!users.size) {
            Vim.unmap(sequence(key), 'normal');
            mapped.delete(key);
          }
        }
        for (const command of view.state.facet(commands)) {
          if (!command.keys) continue;
          if (mapped.has(command.keys)) {
            mapped.get(command.keys)!.add(view);
            continue;
          }
          mapped.set(command.keys, new Set([view]));
          Vim.mapCommand(
            sequence(command.keys),
            'action',
            'portleafCommand',
            { keys: command.keys },
            { context: 'normal' },
          );
        }
      };
      const render = () => {
        const matches = view.state
          .facet(commands)
          .filter((command) => command.keys?.startsWith(prefix));
        const total = Math.max(1, Math.ceil(matches.length / shortcutPageSize));
        page = Math.max(0, Math.min(page, total - 1));
        heading.textContent = prefix ? describeKeys(prefix) : 'Shortcuts';
        pageStatus.textContent = `${page + 1} / ${total}`;
        renderKeyHints(
          choices,
          matches
            .slice(page * shortcutPageSize, (page + 1) * shortcutPageSize)
            .map((command) => [describeKeys(command.keys!), command.label ?? command.title]),
        );
      };
      paging.set(view, (event) => {
        if (
          hint.hidden ||
          event.isComposing ||
          view.composing ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return false;
        const direction = pageDirection(event);
        if (!direction) return false;
        event.preventDefault();
        page += direction;
        render();
        return true;
      });
      const pressed = () => {
        const input = cm?.state.vim?.inputState.keyBuffer.join('').replaceAll('<Space>', ' ') ?? '';
        hint.hidden = !input.startsWith(' ');
        if (hint.hidden) {
          prefix = '';
          page = 0;
          return;
        }
        if (prefix !== input.slice(1)) page = 0;
        prefix = input.slice(1);
        render();
      };
      register();
      const changed = (event: { mode: string; subMode?: string }) => {
        hint.hidden = true;
        context.buffer.setMode(event.mode.toUpperCase());
      };
      cm?.on('vim-mode-change', changed);
      cm?.on('vim-keypress', pressed);
      cm?.on('vim-command-done', pressed);
      context.buffer.setMode('NORMAL');
      return {
        update(update) {
          if (update.transactions.some((transaction) => transaction.reconfigured)) register();
        },
        destroy() {
          cm?.off('vim-mode-change', changed);
          cm?.off('vim-keypress', pressed);
          cm?.off('vim-command-done', pressed);
          hint.remove();
          paging.delete(view);
          contexts.delete(view);
          for (const [key, users] of mapped) {
            users.delete(view);
            if (!users.size) {
              Vim.unmap(sequence(key), 'normal');
              mapped.delete(key);
            }
          }
          if (--views === 0) {
            // @ts-expect-error The default motion applies without a context.
            Vim.map('<Space>', 'l');
          }
          context.buffer.setMode('EDIT');
        },
      };
    }),
  ],
};
