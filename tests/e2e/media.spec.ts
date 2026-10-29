import { test, expect, capture } from './support/desktop.js';
import { pdfFixture } from './support/media.js';
import type { Page } from '@playwright/test';
import { writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';

const plugins = [
  'markdown',
  'markdown-visual',
  'vim',
  'file-browser',
  'navigation',
  'history',
  'outline',
  'text-files',
  'media-viewer',
];
test.use({
  desktopOptions: {
    content: '# Original text\n',
    config: { theme: 'minimal', plugins, pluginApiVersion: 1, fontSize: 14 },
    checkConsoleErrors: false,
    files: {
      'book.pdf': pdfFixture(),
      'image-1.png': Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII=',
        'base64',
      ),
      'image-2.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#aac388"/><circle cx="320" cy="180" r="90" fill="#20352a"/></svg>',
    },
  },
});
async function leader(page: Page, keys: string) {
  for (const key of ['Space', ...keys]) await page.keyboard.press(key);
}
async function open(page: Page, file: string) {
  await leader(page, 'fv');
  await page.getByLabel('Filter', { exact: true }).fill(file);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Quick picker', { exact: true })).toBeHidden();
  await expect(page.locator('.buffer:not([hidden]) .media-viewer')).toHaveAttribute(
    'data-state',
    'ready',
  );
}

test('images use independent buffers, stay outside CRDT storage, and support imv navigation, zoom, rotation and global commands', async ({
  app,
}) => {
  const { page, directory } = app;
  await open(page, 'image-1.png');
  await expect(page.locator('.cm-editor')).toHaveCount(2);
  expect(page.workers().some((worker) => worker.url().includes('pdf.worker'))).toBe(false);
  await page.keyboard.press('ArrowRight');
  const viewer = page.locator('.buffer:not([hidden]) .media-viewer');
  await expect(page.getByRole('img', { name: 'image-2.svg', exact: true })).toBeVisible();
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  const initial = Number(await viewer.getAttribute('data-zoom'));
  await page.keyboard.press('i');
  await expect
    .poll(async () => Number(await viewer.getAttribute('data-zoom')))
    .toBeGreaterThan(initial);
  await page.keyboard.press('Control+r');
  await expect(viewer).toHaveAttribute('data-rotation', '90');
  await page.keyboard.press('r');
  await expect(viewer).toHaveAttribute('data-rotation', '0');
  await open(page, './image-2.svg');
  await expect(page.locator('.media-viewer')).toHaveCount(1);
  await leader(page, 'bb');
  await expect(page.getByLabel('Quick picker', { exact: true }).getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await capture(page, 'image-viewer');
  await page.keyboard.press('q');
  await expect(page.locator('.media-viewer')).toHaveCount(0);
  const [workspaceState] = await readdir(path.join(directory, 'state'));
  const index = JSON.parse(
    await readFile(path.join(directory, 'state', workspaceState, 'index.json'), 'utf8'),
  );
  expect(Object.keys(index)).toEqual(['note.md']);
});

test('PDF renders through a real Worker, changes page sizes, searches, follows outline and keeps source bytes', async ({
  app,
}) => {
  const { page, root } = app;
  const original = await readFile(path.join(root, 'book.pdf'));
  const ranged = await page.evaluate(async () => {
    const bootstrap = await window.portleaf.bootstrap();
    const url = new URL('portleaf-resource://file/');
    url.searchParams.set('workspace', bootstrap.root);
    url.searchParams.set('path', 'book.pdf');
    const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
    return {
      status: response.status,
      body: await response.text(),
      range: response.headers.get('Content-Range'),
    };
  });
  expect(ranged).toMatchObject({ status: 206, body: '%PDF' });
  expect(ranged.range).toMatch(/^bytes 0-3\//);
  await open(page, 'book.pdf');
  const viewer = page.locator('.buffer:not([hidden]) .media-viewer');
  await expect(page.getByLabel('PDF page 1')).toBeVisible();
  expect(page.workers().some((worker) => worker.url().includes('pdf.worker'))).toBe(true);
  await expect(viewer.locator('.media-text-layer')).toContainText('Portleaf PDF first page');
  expect(
    await viewer.locator('canvas').evaluate((canvas: HTMLCanvasElement) =>
      canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value, index) => index % 4 !== 3 && value < 180),
    ),
  ).toBe(true);
  await page.keyboard.press('J');
  await expect(viewer).toHaveAttribute('data-page', '2');
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  await expect(viewer.locator('.media-text-layer')).toContainText('Search second page target');
  await page.keyboard.press('G');
  await expect(viewer).toHaveAttribute('data-page', '3');
  for (const key of ['1', 'G']) await page.keyboard.press(key);
  await expect(viewer).toHaveAttribute('data-page', '1');
  await page.keyboard.press('/');
  await page.getByLabel('Filter', { exact: true }).fill('second');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Quick picker', { exact: true }).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(viewer).toHaveAttribute('data-page', '2');
  await expect(viewer.locator('.media-match.selected')).toHaveText('second');
  await page.keyboard.press('/');
  await page.getByLabel('Filter', { exact: true }).fill('page');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Quick picker', { exact: true }).getByRole('option')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await page.keyboard.press('N');
  await expect(viewer).toHaveAttribute('data-page', '3');
  await page.keyboard.press('n');
  await expect(viewer).toHaveAttribute('data-page', '1');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Quick picker', { exact: true })).toContainText('First chapter');
  await page.keyboard.press('Enter');
  await expect(viewer).toHaveAttribute('data-page', '1');
  await page.keyboard.press('r');
  await expect(viewer).toHaveAttribute('data-rotation', '90');
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  await capture(page, 'pdf-viewer');
  expect(await readFile(path.join(root, 'book.pdf'))).toEqual(original);
});

test('file selector discovers media, previews metadata, and disabling the provider closes its buffers and Workers', async ({
  app,
}) => {
  const { page, config } = app;
  await leader(page, 'ff');
  const browser = page.getByLabel('File selector', { exact: true });
  await expect(browser).toContainText('book.pdf');
  await expect(browser).toContainText('image-1.png');
  await page.keyboard.press('Escape');
  await open(page, 'book.pdf');
  await writeFile(
    path.join(config, 'config.json'),
    JSON.stringify({
      theme: 'minimal',
      plugins: plugins.filter((id) => id !== 'media-viewer'),
      pluginApiVersion: 1,
    }),
  );
  await expect(page.locator('.media-viewer')).toHaveCount(0);
  await expect
    .poll(() => page.workers().filter((worker) => worker.url().includes('pdf.worker')).length)
    .toBe(0);
  await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  await leader(page, 'ff');
  await expect(browser).not.toContainText('book.pdf');
  await expect(browser).not.toContainText('image-1.png');
});

test('broken documents recover on reload, resource requests are confined, and text path aliases reuse one editor', async ({
  app,
}) => {
  const { page, directory, root } = app;
  await writeFile(path.join(root, 'broken.pdf'), 'not a PDF\0');
  await leader(page, 'fv');
  await page.getByLabel('Filter', { exact: true }).fill('broken.pdf');
  await page.keyboard.press('Enter');
  await expect(page.locator('.media-viewer')).toHaveAttribute('data-state', 'error');
  await writeFile(path.join(root, 'broken.pdf'), pdfFixture());
  await page.keyboard.press('R');
  await expect(page.locator('.media-viewer')).toHaveAttribute('data-state', 'ready');
  await page.keyboard.press('q');
  await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  await leader(page, 'ft');
  await page.getByLabel('Filter', { exact: true }).fill('./note.md');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Quick picker', { exact: true })).toBeHidden();
  await expect(page.locator('.cm-editor')).toHaveCount(2);
  await writeFile(path.join(directory, 'outside.png'), 'outside');
  await symlink(path.join(directory, 'outside.png'), path.join(root, 'outside.png'));
  const result = await page.evaluate(async () => {
    try {
      await window.portleaf.inspect('outside.png');
      return 'allowed';
    } catch (error) {
      return String(error);
    }
  });
  expect(result).toContain('outside');
});

test('direct media startup and Space commands work without Vim or Markdown plugins', async ({
  app,
}) => {
  let { page } = app;
  const { config } = app;
  await writeFile(
    path.join(config, 'config.json'),
    JSON.stringify({
      theme: 'minimal',
      plugins: ['media-viewer', 'navigation'],
      pluginApiVersion: 1,
    }),
  );
  await app.restart('image-2.svg', 'state-direct');
  page = app.page;
  await expect(page.locator('.media-viewer')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await leader(page, ' ');
  await expect(page.getByLabel('Quick picker', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await open(page, 'book.pdf');
  await page.keyboard.press('J');
  await expect(page.locator('.media-viewer[data-kind="pdf"]')).toHaveAttribute('data-page', '2');
});

test('closing during PDF loading cancels late work and repeated image navigation keeps one image slot', async ({
  app,
}) => {
  const { page } = app;
  for (let index = 0; index < 3; index++) {
    await leader(page, 'fv');
    await page.getByLabel('Filter', { exact: true }).fill('book.pdf');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'PDF viewer', exact: true })).toBeVisible();
    await page.keyboard.press('q');
    await expect(page.locator('.media-viewer')).toHaveCount(0);
    await expect(page.getByLabel('note.md', { exact: true })).toBeVisible();
  }
  await expect
    .poll(() => page.workers().filter((worker) => worker.url().includes('pdf.worker')).length)
    .toBe(0);
  await open(page, 'image-1.png');
  for (let index = 0; index < 6; index++) {
    const target = index % 2 ? 'image-1.png' : 'image-2.svg';
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('img', { name: target, exact: true })).toBeVisible();
    await expect(page.locator('.media-viewer')).toHaveCount(1);
  }
});
