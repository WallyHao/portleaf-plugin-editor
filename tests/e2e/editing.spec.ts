import { test, expect, capture, dismissPicker } from './support/desktop.js';
import { readFile, writeFile } from 'node:fs/promises';

test('Vim editing, automatic export, external updates, undo isolation, and uniform typography', async ({
  app,
}) => {
  const { desktop, file, errors } = app;
  const page = await desktop.firstWindow();
  await page.keyboard.press('i');
  await page.keyboard.insertText('Local 🐾 中文. ');
  await page.keyboard.press('Escape');
  await expect.poll(() => readFile(file, 'utf8')).toContain('Local 🐾 中文. ');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('Last paragraph.', 'External paragraph.'),
  );
  await expect(page.getByLabel('note.md')).toContainText('External paragraph.');
  await page.keyboard.press('u');
  await expect(page.getByLabel('note.md')).not.toContainText('Local 🐾 中文. ');
  await expect(page.getByLabel('note.md')).toContainText('External paragraph.');
  await page.keyboard.type('  ');
  await expect(page.getByLabel('Quick picker')).toBeVisible();
  const sizes = await page.evaluate(() =>
    ['.cm-content', '.cm-line', '.cm-line span', '.statusline', '.picker-input', '.picker-row'].map(
      (selector) => getComputedStyle(document.querySelector(selector)!).fontSize,
    ),
  );
  expect(new Set(sizes)).toEqual(new Set(['24px']));
  await dismissPicker(page);
  await page.keyboard.type(':');
  await expect(page.locator('.cm-vim-panel input')).toBeVisible();
  const families = await page.evaluate(() =>
    ['.buffer:not([hidden]) .cm-content', '.cm-vim-panel input'].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { family: style.fontFamily, size: style.fontSize };
    }),
  );
  expect(families[0]).toEqual(families[1]);
  await page.keyboard.press('Escape');
  await capture(page, 'editor');
  expect(errors).toEqual([]);
});

test('defers incoming CRDT operations until Chinese composition commits', async ({ app }) => {
  const { desktop, file, errors } = app;
  const page = await desktop.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('i');
  await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
  const imported = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const remove = window.portleaf.onEvent((event) => {
          if (event.type === 'changed') {
            remove();
            resolve();
          }
        });
      }),
  );
  await writeFile(file, '# Heading\n\nFirst paragraph.\n\nExternal paragraph.\n');
  await imported;
  await expect(page.getByLabel('note.md')).not.toContainText('External paragraph.');
  await cdp.send('Input.insertText', { text: '你好' });
  await expect(page.getByLabel('note.md')).toContainText('你好');
  await expect(page.getByLabel('note.md')).toContainText('External paragraph.');
  await page.keyboard.press('Escape');
  await expect.poll(() => readFile(file, 'utf8')).toContain('你好');
  expect(errors).toEqual([]);
});
