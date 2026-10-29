import { test, expect, capture, acceptPicker, searchPicker } from './support/desktop.js';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

test('renders Markdown and switches views without rewriting source or changing typography', async ({
  app,
}) => {
  const { desktop, directory, file, errors } = app;
  const page = await desktop.firstWindow();
  const source =
    '# Heading\n\n**Bold** and *italic*, ~~removed~~ and `code`.\n\n- [ ] Task\n\n![Local image](<pixel image.svg>)\n\nInline $x^2$.\n\n| Item | Value |\n| --- | --- |\n| A | **B** |\n\n$$\nx = \\frac{1}{2}\n$$\n\n```ts\nconst value = 1;\n```\n\nFooter\n';
  await writeFile(
    path.join(directory, 'notes/pixel image.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#b6caa5"/></svg>',
  );
  await writeFile(file, source);
  const editor = page.getByLabel('note.md');
  await expect(editor.locator('.md-strong').first()).toHaveText('Bold');
  await expect(editor.locator('.md-math math')).toHaveCount(2);
  await expect(editor.locator('.md-table table')).toHaveCount(1);
  await expect(editor.locator('.md-code code')).toHaveText('const value = 1;');
  await expect
    .poll(() =>
      editor.locator('.md-image img').evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(32);
  const before = (await stat(file)).mtimeMs;
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await expect(editor.locator('.md-rendered')).toHaveCount(0);
  await expect(editor).toContainText('**Bold**');
  await expect(editor).toContainText('![Local image]');
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('LIVE');
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type('  ');
  await searchPicker(page, 'Toggle Markdown view');
  await acceptPicker(page);
  await expect(page.getByLabel('Markdown view mode')).toHaveText('LIVE');
  const sizes = await page.evaluate(() =>
    [
      '.buffer:not([hidden]) .md-heading',
      '.md-strong',
      '.md-table th',
      '.statusline',
      '.viewmode',
    ].map((selector) => getComputedStyle(document.querySelector(selector)!).fontSize),
  );
  expect(new Set(sizes)).toEqual(new Set(['24px']));
  expect(await readFile(file, 'utf8')).toBe(source);
  expect((await stat(file)).mtimeMs).toBe(before);
  await capture(page, 'markdown-live');
  expect(errors).toEqual([]);
});

test('live editing shares autosave and undo with source mode and external updates', async ({
  app,
}) => {
  const { desktop, file, errors } = app;
  const page = await desktop.firstWindow();
  await writeFile(file, '# Heading\n\n**First** and $x$.\n\n- [ ] Task\n\n');
  const editor = page.getByLabel('note.md');
  await expect(editor.locator('.md-strong')).toHaveText('First');
  await page.keyboard.type('G');
  await page.keyboard.press('i');
  await page.keyboard.press('Control+Shift+m');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('LIVE');
  await expect(page.locator('.mode')).toHaveText('INSERT');
  await page.keyboard.insertText('Local text');
  await page.keyboard.press('Escape');
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  await page.keyboard.type(' mv');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('LIVE');
  await expect.poll(() => readFile(file, 'utf8')).toContain('Local text');
  await writeFile(file, (await readFile(file, 'utf8')).replace('**First**', '**External**'));
  await expect(editor.locator('.md-strong')).toHaveText('External');
  await page.keyboard.press('u');
  await expect(editor).not.toContainText('Local text');
  await expect(editor.locator('.md-strong')).toHaveText('External');
  await editor.getByRole('checkbox').click();
  await expect.poll(() => readFile(file, 'utf8')).toContain('- [x] Task');
  await page.keyboard.press('u');
  await expect.poll(() => readFile(file, 'utf8')).toContain('- [ ] Task');
  expect(errors).toEqual([]);
});

test('opens relative Markdown links and navigates heading anchors from the keyboard', async ({
  app,
}) => {
  const { desktop, directory, file, errors } = app;
  const page = await desktop.firstWindow();
  await writeFile(
    path.join(directory, 'notes/target.md'),
    '# First\n\nText.\n\n# Destination\n\nTarget text.\n',
  );
  await writeFile(file, '# Heading\n\n[Target](target.md#destination)\n\n[Back](#heading)\n\n');
  await expect(page.locator('.md-link').first()).toHaveText('Target');
  await page.keyboard.type('jj');
  await page.keyboard.type(' ml');
  await expect(page.getByLabel('target.md')).toBeVisible();
  await expect(page.locator('.position')).toHaveText('5:1');
  await page.keyboard.type(' bb');
  await searchPicker(page, 'note');
  await acceptPicker(page);
  await page.keyboard.type('jj');
  await page.keyboard.type(' ml');
  await expect(page.locator('.position')).toHaveText('1:1');
  expect(errors).toEqual([]);
});

test('Space m t toggles a task and undo restores its Markdown marker', async ({ app }) => {
  const { desktop, file, errors } = app;
  const page = await desktop.firstWindow();
  await writeFile(file, '- [ ] First task\n');
  await expect(page.getByLabel('note.md')).toContainText('First task');
  await page.keyboard.type(' mt');
  await expect.poll(() => readFile(file, 'utf8')).toBe('- [x] First task\n');
  await page.keyboard.type('u');
  await expect.poll(() => readFile(file, 'utf8')).toBe('- [ ] First task\n');
  expect(errors).toEqual([]);
});

test('document outline searches real headings, jumps in source and live views, and keeps current source intact', async ({
  app,
}) => {
  const { desktop, file, errors } = app;
  const page = await desktop.firstWindow();
  const source =
    '# Root\n\n## **中文** section\n\nBody\n\n```md\n# Hidden code heading\n```\n\nFinal section\n=============\n\nEnd\n';
  await writeFile(file, source);
  await expect(page.getByLabel('note.md')).toContainText('Final section');
  await page.keyboard.type('G');
  await page.keyboard.type(' mo');
  const picker = page.getByLabel('Quick picker');
  await expect(picker.locator('.picker-label')).toHaveText('Document outline');
  await expect(picker.getByRole('option')).toHaveCount(3);
  await expect(picker.locator('[aria-selected="true"]')).toContainText('Final section');
  await capture(page, 'outline');
  await searchPicker(page, '中文');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.locator('.position')).toHaveText('3:1');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('LIVE');
  await page.keyboard.type(' mv');
  await page.keyboard.type(' mo');
  await expect(picker.locator('.picker-label')).toHaveText('Document outline');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.locator('.position')).toHaveText('1:1');
  await expect(page.getByLabel('Markdown view mode')).toHaveText('SOURCE');
  expect(await readFile(file, 'utf8')).toBe(source);
  expect(errors).toEqual([]);
});
