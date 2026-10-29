import {
  test,
  expect,
  capture,
  acceptPicker,
  dismissPicker,
  searchPicker,
  submitName,
} from './support/desktop.js';
import { readFile } from 'node:fs/promises';
import { builtInPlugins } from '../../packages/plugins/src/index.js';
import path from 'node:path';

test('file commands, theme switching, buffer state, and keyboard-only navigation', async ({
  app,
}) => {
  const { desktop, directory, errors, child } = app;
  const page = await desktop.firstWindow();
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type(' fn');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText('New file');
  await submitName(page, 'second.md');
  await expect(page.getByLabel('second.md')).toBeVisible();
  await expect(page.getByLabel('Markdown view mode')).toHaveText('LIVE');
  await page.keyboard.press('i');
  await page.keyboard.insertText('Second buffer');
  await page.keyboard.press('Escape');
  await page.keyboard.type(' bb');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText(
    'Switch buffer',
  );
  await searchPicker(page, 'note');
  await acceptPicker(page);
  await expect(page.getByLabel('note.md')).toBeVisible();
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type('  ');
  await searchPicker(page, 'Select theme');
  await acceptPicker(page);
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText('Select theme');
  await searchPicker(page, 'folio');
  await acceptPicker(page);
  await expect(page.getByLabel('note.md')).toHaveText('# HeadingFirst paragraph.Last paragraph.');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await expect
    .poll(() => readFile(path.join(directory, 'notes/second.md'), 'utf8'))
    .toBe('Second buffer');
  await page.keyboard.type(' qq');
  await expect.poll(() => child.exitCode).toBe(0);
  expect(errors).toEqual([]);
});

test('Space commands preserve native Vim keys, provide help, and cycle and close buffers', async ({
  app,
}) => {
  const { desktop, errors } = app;
  const page = await desktop.firstWindow();
  await page.keyboard.press('Control+p');
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('dialog', { name: 'File selector', exact: true })).toBeHidden();
  await expect(page.getByLabel('Quick picker')).toBeHidden();
  await page.keyboard.press('Space');
  await expect(page.locator('.buffer:not([hidden]) .leader-hint')).toBeVisible();
  await expect(page.locator('.buffer:not([hidden]) .leader-hint')).toContainText('Space f f');
  await page.keyboard.press('Escape');
  await expect(page.locator('.buffer:not([hidden]) .leader-hint')).toBeHidden();
  await page.keyboard.type(' ?');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText(
    'Keyboard shortcuts',
  );
  await searchPicker(page, 'File history');
  await expect(page.getByLabel('Quick picker').getByRole('option')).toContainText('H');
  await dismissPicker(page);
  await page.keyboard.type(' fn');
  await submitName(page, 'second.md');
  await expect(page.getByLabel('second.md', { exact: true })).toBeVisible();
  await page.keyboard.type(' bp');
  await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  await page.keyboard.type(' bn');
  await expect(page.getByLabel('second.md', { exact: true })).toBeVisible();
  await page.keyboard.type(' bd');
  await expect(page.getByLabel('second.md', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  await page.keyboard.type('i');
  await page.keyboard.insertText(' ff mv ordinary spaces ');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('note.md', { exact: true })).toContainText(
    ' ff mv ordinary spaces ',
  );
  await expect(page.getByRole('dialog', { name: 'File selector', exact: true })).toBeHidden();
  expect(errors).toEqual([]);
});

test('Space hints use two columns and page without consuming the pending Vim sequence', async ({
  app,
}) => {
  const { desktop, file, errors } = app;
  const page = await desktop.firstWindow();
  const hint = page.locator('.buffer:not([hidden]) .leader-hint');
  const original = await readFile(file, 'utf8');
  const bindings = builtInPlugins
    .flatMap((plugin) => plugin.commands ?? [])
    .filter((command) => !command.hidden && command.keys);
  const pages = Math.ceil(bindings.length / 12);
  await page.keyboard.press('Space');
  await expect(hint.locator('.picker-page')).toHaveText(`1 / ${pages}`);
  await expect(hint.locator('.leader-choices .shortcut-item')).toHaveCount(12);
  const rows = await hint.locator('.leader-choices .shortcut-item').evaluateAll((items) => {
    const counts = new Map<number, number>();
    for (const item of items) {
      const y = Math.round(item.getBoundingClientRect().y);
      counts.set(y, (counts.get(y) ?? 0) + 1);
    }
    return [...counts.values()];
  });
  expect(rows).toEqual([2, 2, 2, 2, 2, 2]);
  const sizes = await hint
    .locator('.shortcut-key, .shortcut-label, .picker-label, .picker-page')
    .evaluateAll((items) => [...new Set(items.map((item) => getComputedStyle(item).fontSize))]);
  expect(sizes).toEqual(['24px']);
  await capture(page, 'shortcut-hints');
  await page.keyboard.press('Tab');
  await expect(hint.locator('.picker-page')).toHaveText(`2 / ${pages}`);
  await expect(hint.locator('.leader-choices .shortcut-item')).toHaveCount(
    Math.min(12, bindings.length - 12),
  );
  await expect(hint).toContainText('Space u t');
  await page.keyboard.press('Shift+Tab');
  await expect(hint.locator('.picker-page')).toHaveText(`1 / ${pages}`);
  await page.keyboard.press('PageDown');
  await expect(hint.locator('.picker-page')).toHaveText(`2 / ${pages}`);
  await page.keyboard.press('PageUp');
  await expect(hint.locator('.picker-page')).toHaveText(`1 / ${pages}`);
  await expect(page.locator('.position')).toHaveText('1:1');
  await page.keyboard.type('f');
  await expect(hint.locator('.picker-page')).toHaveText('1 / 1');
  await expect(hint.locator('.leader-choices .shortcut-item')).toHaveCount(
    bindings.filter((command) => command.keys!.startsWith('f')).length,
  );
  await page.keyboard.type('n');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText('New file');
  await expect(hint).toBeHidden();
  await page.keyboard.press('Escape');
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(errors).toEqual([]);
});

test('command lists open for arrow navigation, confirm with Enter, and search only after slash', async ({
  app,
}) => {
  const { desktop, errors } = app;
  const page = await desktop.firstWindow();
  const picker = page.getByLabel('Quick picker');
  const selected = picker.locator('[aria-selected="true"]');
  const pages = Math.ceil(
    builtInPlugins.flatMap((plugin) => plugin.commands ?? []).filter((command) => !command.hidden)
      .length / 12,
  );
  await page.keyboard.type('  ');
  await expect(page.getByLabel('Filter')).toBeHidden();
  await expect(picker.getByRole('listbox')).toBeFocused();
  await expect(selected).toHaveAccessibleName(/Toggle Markdown view/);
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveAccessibleName(/Open link under cursor/);
  await page.keyboard.press('ArrowDown');
  await expect(selected).toHaveAccessibleName(/Open file selector/);
  await page.keyboard.press('ArrowLeft');
  await expect(selected).toHaveAccessibleName(/Toggle task under cursor/);
  await page.keyboard.press('ArrowUp');
  await expect(selected).toHaveAccessibleName(/Toggle Markdown view/);
  await capture(page, 'command-list');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type('  ');
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Filter')).toBeHidden();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(picker.locator('.picker-page')).toHaveText(`2 / ${pages}`);
  await page.keyboard.press('Shift+Tab');
  await expect(picker.locator('.picker-page')).toHaveText(`1 / ${pages}`);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  const lastRow = await selected.textContent();
  await page.keyboard.press('ArrowDown');
  await expect(selected).toHaveText(lastRow!);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await searchPicker(page, 'no such command');
  await expect(picker.locator('.picker-list')).toHaveText('No matches');
  await page.keyboard.press('Escape');
  await expect(picker).toBeVisible();
  await expect(page.getByLabel('Filter')).toBeHidden();
  await expect(selected).toHaveAccessibleName(/Open link under cursor/);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await page.keyboard.type('  ');
  await searchPicker(page, 'Select theme');
  await page.keyboard.press('Enter');
  await expect(picker.locator('.picker-label')).toHaveText('Select theme');
  await expect(page.getByLabel('Filter')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveText('minimal');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  expect(errors).toEqual([]);
});
