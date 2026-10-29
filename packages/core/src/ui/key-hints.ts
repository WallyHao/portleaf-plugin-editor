export const shortcutPageSize = 12;

export function pageDirection(event: KeyboardEvent) {
  if (event.key === 'Tab') return event.shiftKey ? -1 : 1;
  if (event.key === 'PageDown') return 1;
  if (event.key === 'PageUp') return -1;
  return 0;
}

export function renderKeyHints(
  container: HTMLElement,
  entries: readonly (readonly [string, string])[],
  columns: 2 | 3 = 2,
) {
  container.classList.add('shortcut-grid');
  container.dataset.columns = String(columns);
  container.replaceChildren(
    ...entries.map(([keys, label]) => {
      const item = document.createElement('div');
      item.className = 'shortcut-item';
      const key = document.createElement('kbd');
      key.className = 'shortcut-key';
      key.textContent = keys;
      const description = document.createElement('span');
      description.className = 'shortcut-label';
      description.textContent = label;
      item.title = `${keys}  ${label}`;
      item.append(key, description);
      return item;
    }),
  );
}
