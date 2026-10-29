import { test, expect, capture, searchPicker, submitName } from './support/desktop.js';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

test('text files browse, edit, undo, rename across document types, copy, and open hidden or extensionless paths', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  const root = path.join(directory, 'notes');
  const textFile = path.join(root, 'config.txt');
  const original = '\ufeff# Literal heading\r\n**literal**\r\n';
  await writeFile(textFile, original);
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 0xff]));
  await writeFile(path.join(root, '.settings'), 'hidden config\n');
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await expect(browser.getByRole('option', { name: 'config.txt' })).toBeVisible();
  await expect(browser.getByRole('option', { name: 'binary.bin' })).toHaveCount(0);
  await browser.getByRole('option', { name: 'config.txt' }).click();
  const editor = page.getByLabel('config.txt', { exact: true });
  await expect(editor).toContainText('**literal**');
  await expect(editor.locator('.md-strong, .md-rendered')).toHaveCount(0);
  await expect(page.getByLabel('Markdown view mode')).toBeHidden();
  expect(await readFile(textFile, 'utf8')).toBe(original);
  await page.keyboard.type('iTyped ');
  await page.keyboard.press('Escape');
  await expect
    .poll(() => readFile(textFile, 'utf8'))
    .toBe('\ufeffTyped # Literal heading\r\n**literal**\r\n');
  await writeFile(
    textFile,
    (await readFile(textFile, 'utf8')).replace('**literal**', '**external**'),
  );
  await expect(editor).toContainText('**external**');
  await page.keyboard.type('u');
  await expect(editor).not.toContainText('Typed');
  await expect(editor).toContainText('**external**');
  await page.keyboard.type(' fr');
  await submitName(page, 'renamed.md');
  await expect(page.getByLabel('renamed.md', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Markdown view mode')).toBeVisible();
  await page.keyboard.type(' fr');
  await submitName(page, 'renamed.txt');
  await expect(page.getByLabel('Markdown view mode')).toBeHidden();
  await page.keyboard.type(' fc');
  await submitName(page, 'copy.txt');
  await expect(page.getByLabel('copy.txt', { exact: true })).toBeVisible();
  expect(await readFile(path.join(root, 'copy.txt'), 'utf8')).toBe(
    await readFile(path.join(root, 'renamed.txt'), 'utf8'),
  );
  await page.keyboard.type(' fn');
  await submitName(page, 'script.py');
  await expect(page.getByLabel('script.py', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Markdown view mode')).toBeHidden();
  await page.keyboard.type(' ft');
  await submitName(page, '.settings');
  await expect(page.getByLabel('.settings', { exact: true })).toContainText('hidden config');
  await page.keyboard.type('  ');
  await searchPicker(page, 'New text file');
  await page.keyboard.press('Enter');
  await submitName(page, 'Makefile');
  await expect(page.getByLabel('Makefile', { exact: true })).toBeVisible();
  await page.keyboard.type('ihello');
  await page.keyboard.press('Escape');
  await expect.poll(() => readFile(path.join(root, 'Makefile'), 'utf8')).toBe('hello');
  await capture(page, 'text-files');
  expect(errors).toEqual([]);
});

test('disabling text browsing filters the selector while preserving open text buffers and outline lifecycle', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  const textFile = path.join(directory, 'notes/plain.txt');
  await writeFile(textFile, '# Literal\n');
  await page.keyboard.type(' ft');
  await submitName(page, 'plain.txt');
  await page.keyboard.type('iKeep ');
  await page.keyboard.press('Escape');
  await page.keyboard.type(' ff');
  const browser = page.getByRole('dialog', { name: 'File selector', exact: true });
  await expect(browser.getByRole('option', { name: 'plain.txt' })).toBeVisible();
  const plugins = [
    'markdown',
    'markdown-visual',
    'vim',
    'file-browser',
    'navigation',
    'history',
    'outline',
  ];
  await writeFile(
    path.join(directory, 'config/config.json'),
    JSON.stringify({ pluginApiVersion: 1, plugins, theme: 'minimal', fontSize: 18 }),
  );
  await expect(page.locator('#app')).not.toHaveAttribute('data-plugins', /text-files/);
  await expect(browser.getByRole('option', { name: 'plain.txt' })).toHaveCount(0);
  await page.keyboard.type('q');
  await expect(page.getByLabel('plain.txt', { exact: true })).toContainText('Keep');
  await expect(page.getByLabel('Markdown view mode')).toBeHidden();
  await expect.poll(() => readFile(textFile, 'utf8')).toContain('Keep');
  await page.keyboard.type(' bb');
  await searchPicker(page, 'note.md');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' mo');
  await expect(page.getByLabel('Quick picker')).toBeVisible();
  await writeFile(
    path.join(directory, 'config/config.json'),
    JSON.stringify({
      pluginApiVersion: 1,
      plugins: plugins.filter((id) => id !== 'outline'),
      theme: 'minimal',
      fontSize: 18,
    }),
  );
  await expect(page.locator('#app')).not.toHaveAttribute('data-plugins', /outline/);
  await expect(page.getByLabel('Quick picker')).toBeHidden();
  expect(errors).toEqual([]);
});

test('text syntax uses lazy language grammars and theme colors, preserves bytes, and supports buffer-local overrides', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  const source = '\ufeffconst answer: number = 42;\r\n// comment\r\nconsole.log("中文");\r\n';
  const code = path.join(directory, 'notes/example.ts');
  await writeFile(code, source);
  const modified = (await stat(code)).mtimeMs;
  await page.keyboard.type(' ft');
  await submitName(page, 'example.ts');
  const editor = page.getByLabel('example.ts', { exact: true });
  const language = page.getByRole('button', { name: 'File language', exact: true });
  await expect(language).toHaveText('TypeScript');
  await expect(editor.locator('.cm-line span').filter({ hasText: /^const$/ })).toBeVisible();
  const styles = await editor.evaluate((element) =>
    Object.fromEntries(
      ['const', '42', '// comment'].map((token) => {
        const span = [...element.querySelectorAll('.cm-line span')].find(
          (span) => span.textContent === token,
        )!;
        return [
          token,
          { color: getComputedStyle(span).color, size: getComputedStyle(span).fontSize },
        ];
      }),
    ),
  );
  expect(styles.const.color).not.toBe(styles['// comment'].color);
  expect(styles.const.color).not.toBe(styles['42'].color);
  expect(new Set(Object.values(styles).map((style) => style.size))).toEqual(new Set(['24px']));
  expect((await stat(code)).mtimeMs).toBe(modified);
  await page.keyboard.type(' ul');
  await searchPicker(page, 'Plain text');
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('Plain text');
  await expect(editor.locator('.cm-line span')).toHaveCount(0);
  await page.keyboard.type(' ul');
  await searchPicker(page, 'Python');
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('Python');
  await page.keyboard.type(' ut');
  await searchPicker(page, 'folio');
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('Python');
  await page.keyboard.type(' ul');
  await searchPicker(page, 'Auto-detect');
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('TypeScript');
  await page.keyboard.type('iTyped ');
  await page.keyboard.press('Escape');
  await page.keyboard.type(' ul');
  await searchPicker(page, 'Plain text');
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('Plain text');
  await page.keyboard.type('u');
  await expect.poll(() => readFile(code, 'utf8')).toBe(source);
  await page.keyboard.type(' ul');
  await searchPicker(page, 'Auto-detect');
  await page.keyboard.press('Enter');
  await expect(language).toHaveText('TypeScript');
  await page.keyboard.type(' fr');
  await submitName(page, 'example.py');
  await expect(language).toHaveText('Python');
  await expect(page.getByLabel('example.py', { exact: true })).toBeVisible();
  await page.keyboard.type(' bb');
  await searchPicker(page, 'note.md');
  await page.keyboard.press('Enter');
  await expect(language).toBeHidden();
  await expect(page.getByLabel('Markdown view mode')).toBeVisible();
  expect(await readFile(path.join(directory, 'notes/example.py'), 'utf8')).toBe(source);
  expect(errors).toEqual([]);
});

test('Nix and extensionless scripts highlight and plugin disable removes language UI without losing edits', async ({
  app,
}) => {
  const { desktop, directory, errors } = app;
  const page = await desktop.firstWindow();
  const root = path.join(directory, 'notes');
  await writeFile(path.join(root, 'flake.nix'), 'let message = "中文"; in message\n');
  await writeFile(path.join(root, 'run'), '#!/usr/bin/env python3\nprint("hello")\n');
  await page.keyboard.type(' ft');
  await submitName(page, 'flake.nix');
  const language = page.getByRole('button', { name: 'File language', exact: true });
  await expect(language).toHaveText('Nix');
  await expect(
    page
      .getByLabel('flake.nix', { exact: true })
      .locator('.cm-line span')
      .filter({ hasText: /^let$/ }),
  ).toBeVisible();
  await capture(page, 'syntax-nix');
  await page.keyboard.type(' ft');
  await submitName(page, 'run');
  await expect(language).toHaveText('Python');
  await writeFile(path.join(root, 'run'), '#!/bin/bash\necho "hello"\n');
  await expect(language).toHaveText('Shell');
  await page.keyboard.press('i');
  await page.keyboard.insertText('# local\n');
  await page.keyboard.press('Escape');
  await expect.poll(() => readFile(path.join(root, 'run'), 'utf8')).toContain('# local');
  await page.keyboard.type(' ul');
  await expect(page.getByLabel('Quick picker')).toBeVisible();
  await writeFile(
    path.join(directory, 'config/config.json'),
    JSON.stringify({
      pluginApiVersion: 1,
      plugins: [
        'markdown',
        'markdown-visual',
        'vim',
        'file-browser',
        'navigation',
        'history',
        'outline',
      ],
      theme: 'minimal',
      fontSize: 18,
    }),
  );
  await expect(language).toHaveCount(0);
  await expect(page.getByLabel('Quick picker')).toBeHidden();
  await expect(page.getByLabel('run', { exact: true })).toContainText('# local');
  await page.keyboard.type('u');
  await expect
    .poll(() => readFile(path.join(root, 'run'), 'utf8'))
    .toBe('#!/bin/bash\necho "hello"\n');
  expect(errors).toEqual([]);
});
