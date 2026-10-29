import fuzzysort from 'fuzzysort';
import { pageDirection, renderKeyHints, shortcutPageSize } from './key-hints.js';

export type Choice = {
  label: string;
  display?: string;
  detail?: string;
  run(): void | Promise<void>;
  preview?: string;
};
export type Picker = {
  show(title: string, items: Choice[], done?: () => void, selected?: number): void;
  prompt(
    title: string,
    value: string,
    run: (value: string) => Promise<void>,
    done?: () => void,
  ): void;
  close(): void;
  readonly visible: boolean;
};

type RowCache = {
  choices: Choice[];
  offset: number;
  rows: HTMLButtonElement[];
  selected: number;
  accept: (index: number) => void;
};
const rowCaches = new WeakMap<HTMLElement, RowCache>();

export function renderRows(
  list: HTMLElement,
  choices: Choice[],
  selected: number,
  accept: (index: number) => void,
  offset = 0,
  reveal = true,
  total = choices.length + offset,
) {
  const cache = rowCaches.get(list);
  if (
    cache &&
    cache.offset === offset &&
    cache.choices.length === choices.length &&
    (cache.choices === choices ||
      choices.every((choice, index) => {
        const previous = cache.choices[index];
        return (
          choice.label === previous.label &&
          choice.display === previous.display &&
          choice.detail === previous.detail
        );
      }))
  ) {
    cache.accept = accept;
    for (const row of cache.rows) row.setAttribute('aria-setsize', String(total));
    cache.rows[cache.selected]?.setAttribute('aria-selected', 'false');
    cache.rows[selected]?.setAttribute('aria-selected', 'true');
    cache.selected = selected;
    if (reveal) cache.rows[selected]?.scrollIntoView({ block: 'nearest' });
    return;
  }
  list.replaceChildren();
  const current: RowCache = { choices, offset, rows: [], selected, accept };
  rowCaches.set(list, current);
  choices.forEach((choice, index) => {
    const row = document.createElement('button');
    row.className = 'picker-row';
    row.type = 'button';
    row.id = `${list.id}-option-${index + offset}`;
    row.title = choice.label;
    if (choice.display)
      row.setAttribute('aria-label', [choice.label, choice.detail].filter(Boolean).join(' '));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-setsize', String(total));
    row.setAttribute('aria-posinset', String(index + offset + 1));
    row.setAttribute('aria-selected', String(index === selected));
    row.tabIndex = -1;
    const title = document.createElement('span');
    title.textContent = choice.display ?? choice.label;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = choice.detail ?? '';
    row.append(title, detail);
    row.onmousedown = (event) => event.preventDefault();
    row.onclick = () => current.accept(index);
    current.rows.push(row);
    list.append(row);
  });
  if (reveal) list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

export function createPicker(
  root: HTMLElement,
  onClose: () => void,
  onError: (error: unknown) => void,
) {
  const panel = document.createElement('section');
  panel.className = 'picker';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Quick picker');
  panel.innerHTML =
    '<div class="picker-heading"><label class="picker-label"></label><span class="picker-page" aria-live="polite"></span></div><input class="picker-input" spellcheck="false" autocomplete="off" aria-label="Filter" placeholder="/ Search" role="combobox" aria-controls="quick-options" aria-expanded="true" hidden><div id="quick-options" class="picker-list quick-list" role="listbox" tabindex="0"></div><pre class="picker-preview" hidden></pre><div class="picker-hint"></div>';
  root.append(panel);
  const label = panel.querySelector<HTMLElement>('label')!;
  const input = panel.querySelector<HTMLInputElement>('input')!;
  const list = panel.querySelector<HTMLElement>('.picker-list')!;
  const preview = panel.querySelector<HTMLElement>('.picker-preview')!;
  const hint = panel.querySelector<HTMLElement>('.picker-hint')!;
  const pageStatus = panel.querySelector<HTMLElement>('.picker-page')!;
  let choices: Choice[] = [],
    shown: Choice[] = [];
  let selected = 0,
    searching = false,
    beforeSearch = 0,
    busy = false;
  let submit: ((value: string) => Promise<void>) | undefined;
  let afterClose = onClose;
  let generation = 0;
  let owner: object | undefined;
  function close() {
    if (panel.hidden) return;
    generation++;
    panel.hidden = true;
    choices = [];
    shown = [];
    submit = undefined;
    list.replaceChildren();
    rowCaches.delete(list);
    preview.textContent = '';
    input.value = '';
    const done = afterClose;
    afterClose = onClose;
    owner = undefined;
    done();
  }
  async function accept() {
    if (busy) return;
    const version = generation;
    try {
      if (submit) {
        const value = input.value.trim();
        if (!value) return;
        busy = true;
        await submit(value);
        if (generation === version) close();
      } else if (shown[selected]) {
        const choice = shown[selected];
        close();
        await choice.run();
      }
    } catch (error) {
      onError(error);
    } finally {
      if (generation === version) busy = false;
    }
  }
  function render() {
    shown = input.value
      ? fuzzysort
          .go(input.value, choices, { key: 'label', all: true, limit: 200 })
          .map((result) => result.obj)
      : choices;
    selected = Math.max(0, Math.min(selected, shown.length - 1));
    const offset = Math.floor(selected / shortcutPageSize) * shortcutPageSize;
    renderRows(
      list,
      shown.slice(offset, offset + shortcutPageSize),
      selected - offset,
      (index) => {
        selected = index + offset;
        void accept();
      },
      offset,
      true,
      shown.length,
    );
    if (!shown.length && !submit) list.textContent = 'No matches';
    preview.hidden = !!submit || !shown[selected]?.preview;
    preview.textContent = shown[selected]?.preview ?? '';
    input.hidden = !submit && !searching;
    list.hidden = !!submit;
    pageStatus.hidden = !!submit;
    pageStatus.textContent = `${Math.floor(selected / shortcutPageSize) + 1} / ${Math.max(1, Math.ceil(shown.length / shortcutPageSize))}`;
    for (const target of [input, list]) {
      if (shown.length)
        target.setAttribute('aria-activedescendant', `${list.id}-option-${selected}`);
      else target.removeAttribute('aria-activedescendant');
    }
    renderKeyHints(
      hint,
      submit
        ? [
            ['Enter', 'Confirm'],
            ['Esc', 'Cancel'],
          ]
        : searching
          ? [
              ['Enter', 'Choose'],
              ['Esc', 'Back'],
              ['↑↓', 'Rows'],
              ['Tab / Shift+Tab', 'Page'],
            ]
          : [
              ['↑↓ / jk', 'Rows'],
              ['←→ / hl', 'Columns'],
              ['Enter', 'Choose'],
              ['/', 'Search'],
              ['Tab / Shift+Tab', 'Page'],
              ['Esc', 'Close'],
            ],
    );
  }
  input.oninput = () => {
    selected = 0;
    render();
  };
  panel.onkeydown = (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (submit) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void accept();
      }
      return;
    }
    const paging = pageDirection(event);
    if (paging) {
      event.preventDefault();
      const page = Math.max(
        0,
        Math.min(
          Math.floor(selected / shortcutPageSize) + paging,
          Math.ceil(shown.length / shortcutPageSize) - 1,
        ),
      );
      selected = Math.max(
        0,
        Math.min(page * shortcutPageSize + (selected % shortcutPageSize), shown.length - 1),
      );
      render();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (searching) {
        searching = false;
        input.value = '';
        selected = beforeSearch;
        render();
        list.focus();
      } else close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void accept();
      return;
    }
    if (searching && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const key = event.key;
    if (key === '/') {
      beforeSearch = selected;
      searching = true;
      render();
      input.focus();
      return;
    }
    if (
      ['j', 'ArrowDown'].includes(key) &&
      Math.floor(selected / 2) < Math.floor((shown.length - 1) / 2)
    )
      selected = Math.min(selected + 2, shown.length - 1);
    if (['k', 'ArrowUp'].includes(key) && selected >= 2) selected -= 2;
    if (['h', 'ArrowLeft'].includes(key) && selected % 2) selected--;
    if (['l', 'ArrowRight'].includes(key) && !(selected % 2) && selected + 1 < shown.length)
      selected++;
    if (key === 'Home') selected = 0;
    if (key === 'G' || key === 'End') selected = shown.length - 1;
    render();
  };
  const picker: Picker = {
    show(title: string, items: Choice[], done = onClose, initialSelection = 0) {
      generation++;
      label.textContent = title;
      choices = items;
      submit = undefined;
      selected = initialSelection;
      searching = false;
      beforeSearch = 0;
      busy = false;
      afterClose = done;
      input.value = '';
      list.setAttribute('aria-label', title);
      panel.hidden = false;
      render();
      list.focus();
    },
    prompt(title: string, value: string, run: (value: string) => Promise<void>, done = onClose) {
      generation++;
      label.textContent = title;
      choices = [];
      submit = run;
      selected = 0;
      searching = false;
      busy = false;
      afterClose = done;
      input.value = value;
      panel.hidden = false;
      render();
      input.focus();
      input.select();
    },
    close,
    get visible() {
      return !panel.hidden;
    },
  };
  return {
    scope() {
      const token = {};
      let disposed = false;
      const scoped: Picker = {
        show(...args) {
          if (disposed) return;
          owner = token;
          picker.show(...args);
        },
        prompt(...args) {
          if (disposed) return;
          owner = token;
          picker.prompt(...args);
        },
        close() {
          if (owner === token) close();
        },
        get visible() {
          return owner === token && picker.visible;
        },
      };
      return {
        picker: scoped,
        destroy() {
          disposed = true;
          scoped.close();
        },
      };
    },
    destroy() {
      generation++;
      panel.remove();
    },
  };
}
