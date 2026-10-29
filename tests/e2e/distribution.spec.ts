import { test, expect } from './support/desktop.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test.skip(!process.env.PORTLEAF_APP_PATH, 'Requires the extracted distribution application path.');
test.use({ desktopOptions: { application: path.resolve('.') } });

test('packaged application reopens an existing workspace without changing bytes or document identity', async ({
  app,
}) => {
  await app.page.keyboard.press('i');
  await app.page.keyboard.insertText('Survives the application upgrade. ');
  await app.page.keyboard.press('Escape');
  await expect
    .poll(() => readFile(app.file, 'utf8'))
    .toContain('Survives the application upgrade.');
  const state = path.join(app.directory, 'state');
  const [store] = await readdir(state);
  const index = path.join(state, store, 'index.json');
  const before = JSON.parse(await readFile(index, 'utf8'))['note.md'].url;
  const content = await readFile(app.file);
  await app.page.keyboard.type(' qq');
  await expect.poll(() => app.child.exitCode).toBe(0);
  await app.restart('note.md', 'state', process.env.PORTLEAF_APP_PATH);
  await expect(app.page.getByLabel('note.md', { exact: true })).toContainText(
    'Survives the application upgrade.',
  );
  expect(await readFile(app.file)).toEqual(content);
  expect(JSON.parse(await readFile(index, 'utf8'))['note.md'].url).toBe(before);
});
