import { test, expect } from './support/desktop.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

test.describe('invalid startup configuration', () => {
  test.use({ desktopOptions: { configSource: 'null' } });

  test('opens the document with defaults, explains the invalid configuration and reloads a repair', async ({
    app,
  }) => {
    await expect(app.page.getByRole('status')).toContainText('Invalid config.json:');
    await expect(app.page.getByLabel('note.md', { exact: true })).toBeVisible();
    const config = path.join(app.config, 'config.json');
    expect(await readFile(config, 'utf8')).toBe('null');
    await writeFile(config, JSON.stringify({ theme: 'minimal', plugins: ['markdown', 'vim'] }));
    await expect(app.page.locator('#app')).toHaveAttribute('data-plugins', /theme-minimal/);
    await expect(app.page.locator('#app')).not.toHaveAttribute('data-plugins', /file-browser/);
  });
});

test('invalid live configuration keeps the current editor and continues saving edits', async ({
  app,
}) => {
  const config = path.join(app.config, 'config.json');
  await writeFile(config, JSON.stringify({ plugins: 123 }));
  await expect(app.page.getByRole('status')).toContainText('plugins must be an array');
  await expect(app.page.locator('#app')).toHaveAttribute('data-plugins', /vim/);
  await app.page.keyboard.press('i');
  await app.page.keyboard.insertText('Still editable. ');
  await app.page.keyboard.press('Escape');
  await expect.poll(() => readFile(app.file, 'utf8')).toContain('Still editable. ');
  expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ plugins: 123 });
});
