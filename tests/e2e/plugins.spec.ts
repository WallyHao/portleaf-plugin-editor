import { test, expect, submitName } from './support/desktop.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('plugin lifecycle removes owned UI, rejects bad configuration, and preserves buffer data and typography', async ({
  app,
}) => {
  const { desktop, directory, file, errors } = app;
  const page = await desktop.firstWindow();
  const plugins = ['markdown', 'markdown-visual', 'vim', 'file-browser', 'navigation', 'history'];
  const configure = async (enabled: string[]) => {
    await writeFile(
      path.join(directory, 'config/config.json'),
      JSON.stringify({
        pluginApiVersion: 1,
        plugins: enabled,
        fontSize: 18,
        fontFamily: 'monospace',
        theme: 'minimal',
      }),
    );
    await expect
      .poll(async () =>
        (await page.locator('#app').getAttribute('data-plugins'))
          ?.split(' ')
          .filter((id) => id !== 'theme-minimal')
          .sort()
          .join(','),
      )
      .toBe([...enabled].sort().join(','));
  };
  await page.keyboard.type(' fn');
  await submitName(page, 'temporary');
  await page.keyboard.type(' bd');
  await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  expect(
    await page.locator('#app').evaluate((root) => ({
      background: getComputedStyle(root).backgroundColor,
      font: getComputedStyle(root).fontSize,
    })),
  ).toEqual({ background: 'rgb(23, 26, 27)', font: '24px' });
  await page.keyboard.type('iLocal change. ');
  await page.keyboard.press('Escape');
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type(' ff');
  await page.keyboard.type('n');
  await expect(page.getByLabel('Quick picker')).toBeVisible();
  await configure(plugins.filter((id) => id !== 'file-browser'));
  await expect(page.getByRole('dialog', { name: 'File selector', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Quick picker')).toBeHidden();
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type('  ');
  await expect(
    page.getByLabel('Quick picker').getByRole('option', { name: /Open file selector/ }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await configure(plugins.filter((id) => id !== 'history'));
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await expect(browser).toBeVisible();
  await expect(browser.locator('.shortcut-key', { hasText: /^H$/ })).toHaveCount(0);
  await configure(plugins);
  await expect(browser.locator('.shortcut-key', { hasText: /^H$/ })).toHaveCount(1);
  await page.keyboard.type('H');
  await expect(page.getByLabel('Quick picker').locator('.picker-label')).toContainText('History');
  await configure(plugins.filter((id) => id !== 'history'));
  await expect(page.getByLabel('Quick picker')).toBeHidden();
  await page.keyboard.type('q');
  await configure(plugins);
  await writeFile(
    path.join(directory, 'config/config.json'),
    JSON.stringify({
      pluginApiVersion: 1,
      plugins: [...plugins, 'missing-plugin'],
      theme: 'minimal',
      fontSize: 18,
    }),
  );
  await expect(page.getByRole('status')).toContainText('Unknown plugin: missing-plugin');
  await expect(page.locator('#app')).not.toHaveAttribute('data-plugins', /missing-plugin/);
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('Last paragraph.', 'External paragraph.'),
  );
  await expect(page.getByLabel('note.md', { exact: true })).toContainText('External paragraph.');
  await page.keyboard.type('u');
  await expect(page.getByLabel('note.md', { exact: true })).not.toContainText('Local change.');
  await expect(page.getByLabel('note.md', { exact: true })).toContainText('External paragraph.');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await expect(page.locator('.leader-hint')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('loads presentation only while enabled and preserves long-note edits through worker parsing and buffer closure', async ({
  app,
}) => {
  const { desktop, directory, file, errors } = app;
  const page = await desktop.firstWindow();
  const config = path.join(directory, 'config/config.json');
  await writeFile(
    config,
    JSON.stringify({
      pluginApiVersion: 1,
      plugins: ['markdown', 'vim', 'file-browser', 'navigation', 'history'],
      theme: 'minimal',
      fontSize: 18,
    }),
  );
  await expect(page.getByLabel('Markdown view mode')).toHaveCount(0);
  const source = Array.from(
    { length: 300 },
    (_, index) => `## Heading ${index}\n\n**Paragraph ${index}** and $x^2$.\n\n`,
  ).join('');
  await writeFile(file, source);
  await expect(page.getByLabel('note.md')).toContainText('Heading 0');
  await writeFile(
    config,
    JSON.stringify({
      pluginApiVersion: 1,
      plugins: ['markdown', 'markdown-visual', 'vim', 'file-browser', 'navigation', 'history'],
      theme: 'minimal',
      fontSize: 18,
    }),
  );
  await expect(page.getByLabel('Markdown view mode')).toBeVisible();
  await expect(page.locator('.md-strong').first()).toContainText('Paragraph 0');
  await page.keyboard.type('i');
  await page.keyboard.insertText('Typed during parsing. ');
  await page.keyboard.press('Escape');
  await expect.poll(() => readFile(file, 'utf8')).toContain('Typed during parsing.');
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type('u');
  await expect.poll(() => readFile(file, 'utf8')).toBe(source);
  await page.keyboard.type(' mv');
  await page.keyboard.type(' bd');
  await expect(page.getByLabel('note.md', { exact: true })).toHaveCount(0);
  await page.keyboard.type(' ff');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  await expect(page.locator('.md-strong').first()).toContainText('Paragraph 0');
  expect(errors).toEqual([]);
});
