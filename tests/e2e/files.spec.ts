import {
  test,
  expect,
  capture,
  acceptPicker,
  dismissPicker,
  submitName,
} from './support/desktop.js';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

test('file selector creates folders and files, renames the open buffer, copies, and opens selected-file history', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await expect(browser).toBeVisible();
  await page.keyboard.type('m');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText(
    'New directory',
  );
  expect(
    await page.getByLabel('Quick picker').evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return panel.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 10));
    }),
  ).toBe(true);
  await submitName(page, 'drafts');
  await expect(browser.getByRole('option', { name: 'drafts/ directory' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await stat(path.join(directory, 'notes/drafts'))).isDirectory()).toBe(true);
  await page.keyboard.type('l');
  await expect(browser.locator('.browser-path')).toContainText('drafts');
  await page.keyboard.type('n');
  await submitName(page, 'first note');
  const original = path.join(directory, 'notes/drafts/first note.md');
  await expect(browser.getByRole('option', { name: 'first note.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await readFile(original, 'utf8')).toBe('');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('drafts/first note.md')).toBeVisible();
  await page.keyboard.type('i');
  await page.keyboard.insertText('A draft with history.');
  await page.keyboard.press('Escape');
  await page.keyboard.type(' mv');
  await page.keyboard.type(' ff');
  await page.keyboard.type('r');
  await submitName(page, 'renamed.md');
  await expect(browser.getByRole('option', { name: 'renamed.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('drafts/renamed.md', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await expect
    .poll(() => readFile(path.join(directory, 'notes/drafts/renamed.md'), 'utf8'))
    .toBe('A draft with history.');
  await expect(readFile(original)).rejects.toMatchObject({ code: 'ENOENT' });
  await page.keyboard.type('c');
  await submitName(page, 'copied.md');
  await expect(browser.getByRole('option', { name: 'copied.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await readFile(path.join(directory, 'notes/drafts/copied.md'), 'utf8')).toBe(
    'A draft with history.',
  );
  await page.keyboard.type('H');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText(
    'History · copied.md',
  );
  await expect(page.getByLabel('Quick picker').locator('.picker-preview')).toHaveText(
    'A draft with history.',
  );
  await dismissPicker(page);
  await page.keyboard.type('jH');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toHaveText(
    'History · renamed.md',
  );
  await page.keyboard.type('G');
  await acceptPicker(page);
  await expect
    .poll(() => readFile(path.join(directory, 'notes/drafts/renamed.md'), 'utf8'))
    .toBe('');
  await page.keyboard.type('h');
  await expect(browser.locator('.browser-path')).toHaveText('Files · / ');
  await page.keyboard.type('q');
  await expect(browser).toBeHidden();
  expect(errors).toEqual([]);
});

test('file selector searches recursively, isolates text input, and refreshes external directory changes', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  await mkdir(path.join(directory, 'notes/nested'));
  await writeFile(path.join(directory, 'notes/nested/target.md'), '# Search target\n');
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await page.keyboard.type('ggl');
  await expect(browser.locator('.browser-path')).toContainText('nested');
  await page.keyboard.type('h');
  await expect(browser.locator('.browser-path')).toHaveText('Files · / ');
  await page.keyboard.type('/');
  await page.getByLabel('Search file names').fill('target');
  await expect(browser.getByRole('option', { name: 'nested/target.md' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(browser.locator('.browser-preview')).toContainText('# Search target');
  await page.keyboard.type('l');
  await expect(page.getByLabel('nested/target.md', { exact: true })).toBeVisible();
  await page.keyboard.type(' ff');
  await writeFile(path.join(directory, 'notes/nested/external.md'), 'Added by another editor.\n');
  await expect(browser.getByRole('option', { name: 'external.md' })).toBeVisible();
  await page.keyboard.type('n');
  await submitName(page, 'text with n r c m spaces');
  await expect(browser.getByRole('option', { name: 'text with n r c m spaces.md' })).toBeVisible();
  await capture(page, 'file-selector');
  await page.keyboard.type('gg');
  await page.keyboard.down('j');
  await page.keyboard.down('j');
  await page.keyboard.up('j');
  await expect(
    browser.getByRole('option', { name: 'text with n r c m spaces.md' }),
  ).toHaveAttribute('aria-selected', 'true');
  const sizes = await browser.evaluate((root) => [
    ...new Set(
      [
        ...root.querySelectorAll(
          '.browser-path, .picker-row, .browser-preview, .picker-hint, .shortcut-key, .shortcut-label',
        ),
      ].map((element) => getComputedStyle(element).fontSize),
    ),
  ]);
  expect(sizes).toEqual(['24px']);
  const footer = browser.locator('.picker-hint .shortcut-item');
  await expect(footer).toHaveCount(9);
  await expect(browser).toBeVisible();
  await expect
    .poll(() =>
      footer.evaluateAll((items) => {
        const rows = new Map<number, number>();
        for (const item of items) {
          const y = Math.round(item.getBoundingClientRect().y);
          rows.set(y, (rows.get(y) ?? 0) + 1);
        }
        return [...rows.values()];
      }),
    )
    .toEqual([3, 3, 3]);
  await page.keyboard.type('q');
  expect(errors).toEqual([]);
});

test('file selector excludes dotfiles and hidden ancestors from listing, preview, search, and refresh', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  for (const folder of ['.hidden', 'visible/.nested'])
    await mkdir(path.join(directory, 'notes', folder), { recursive: true });
  for (const name of [
    '.secret.md',
    '.hidden/secret.md',
    'visible/.nested/secret.md',
    'visible/.secret.md',
  ])
    await writeFile(path.join(directory, 'notes', name), 'Hidden note\n');
  await writeFile(path.join(directory, 'notes/visible/public.name.md'), 'Public note\n');
  // Indexed hidden documents must stay recoverable without leaking into the selector.
  await page.evaluate(async () => {
    await window.portleaf.open('.secret.md');
    await window.portleaf.open('.hidden/secret.md');
  });
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await expect(browser.getByRole('option')).toHaveCount(2);
  await expect(browser.getByRole('option', { name: 'visible/ directory' })).toBeVisible();
  await page.keyboard.type('gg');
  await expect(browser.getByLabel('File preview')).toHaveText('public.name.md');
  await page.keyboard.type('/');
  await page.getByLabel('Search file names').fill('secret');
  await expect(browser.getByRole('option')).toHaveCount(0);
  await page.getByLabel('Search file names').fill('public');
  await expect(browser.getByRole('option', { name: 'visible/public.name.md' })).toBeVisible();
  await page.keyboard.press('Escape');
  await writeFile(path.join(directory, 'notes/.external.md'), 'Hidden external note\n');
  await writeFile(path.join(directory, 'notes/external.name.md'), 'Visible external note\n');
  await expect(browser.getByRole('option', { name: 'external.name.md' })).toBeVisible();
  await expect(browser.getByRole('option')).toHaveCount(3);
  await page.keyboard.type('q');
  expect(errors).toEqual([]);
});

test('large file lists keep bounded rows and preserve selection through keyboard and mouse scrolling', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  await Promise.all(
    Array.from({ length: 450 }, (_, index) =>
      writeFile(
        path.join(directory, 'notes', `bulk-${String(index).padStart(3, '0')}.md`),
        `# Note ${index}\n`,
      ),
    ),
  );
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await expect(browser.getByRole('option', { name: 'note.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await browser.getByRole('option').count()).toBeLessThanOrEqual(56);
  await page.keyboard.type('gg');
  await expect(browser.getByRole('option', { name: 'bulk-000.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.type('jjj');
  await expect(browser.getByRole('option', { name: 'bulk-003.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.type('G');
  await expect(browser.getByRole('option', { name: 'note.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await browser.locator('.browser-list').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(browser.getByRole('option', { name: 'bulk-000.md' })).toBeVisible();
  await writeFile(path.join(directory, 'notes/bulk-new.md'), '# Added while scrolling\n');
  await expect(browser.getByRole('option', { name: 'bulk-000.md' })).toHaveAttribute(
    'aria-setsize',
    '452',
  );
  await browser.getByRole('option', { name: 'bulk-005.md' }).click();
  await expect(page.getByLabel('bulk-005.md', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
