import { test, expect } from './support/desktop.js';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test('failed saving can cancel close without freezing the editor or overwriting invalid bytes', async ({
  app,
}) => {
  await app.desktop.evaluate(({ dialog }) => {
    Reflect.set(globalThis, 'closePrompts', 0);
    dialog.showMessageBox = (async () => {
      Reflect.set(globalThis, 'closePrompts', Number(Reflect.get(globalThis, 'closePrompts')) + 1);
      return { response: 2, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await writeFile(app.file, Buffer.from([0xff, 0xfe]));
  await app.page.keyboard.type(' qq');
  await expect
    .poll(() => app.desktop.evaluate(() => Reflect.get(globalThis, 'closePrompts')))
    .toBe(1);
  await expect
    .poll(() => app.page.locator('#app').evaluate((element) => (element as HTMLElement).inert))
    .toBe(false);
  expect(app.child.exitCode).toBeNull();
  expect(await readFile(app.file)).toEqual(Buffer.from([0xff, 0xfe]));
});

test('failed saving writes a recovery copy before quitting and leaves the original file intact', async ({
  app,
}) => {
  await app.desktop.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (_window: unknown, options: { title: string }) => ({
      response: options.title === 'Changes need recovery' ? 1 : 0,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
  });
  await app.page.keyboard.press('i');
  await app.page.keyboard.insertText('Keep this recovery text. ');
  await app.page.keyboard.press('Escape');
  await writeFile(app.file, Buffer.from([0xff]));
  await app.page.keyboard.type(' qq');
  await expect.poll(() => app.child.exitCode).toBe(0);
  const directory = path.join(app.directory, 'state/recovery');
  const copies = await readdir(directory);
  const saved = JSON.parse(await readFile(path.join(directory, copies[0]), 'utf8'));
  expect(
    saved.documents.some((doc: { text: string }) => doc.text.includes('Keep this recovery text.')),
  ).toBe(true);
  expect(await readFile(app.file)).toEqual(Buffer.from([0xff]));
});

test('data-service failure disables editing and offers an independent recovery copy', async ({
  app,
}) => {
  await app.desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('event', {
      type: 'data-unavailable',
      message: 'Data worker stopped for this scenario.',
    });
  });
  await expect(app.page.getByRole('alert')).toContainText('Saving is unavailable');
  await expect(app.page.getByLabel('note.md', { exact: true })).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await app.page.getByRole('button', { name: 'Save recovery copy', exact: true }).click();
  await expect(app.page.getByRole('status')).toContainText('Recovery copy saved:');
  const directory = path.join(app.directory, 'state/recovery');
  const [copy] = await readdir(directory);
  const saved = JSON.parse(await readFile(path.join(directory, copy), 'utf8'));
  expect(
    saved.documents.some(
      (doc: { path: string; text: string }) =>
        doc.path === 'note.md' && doc.text.includes('First paragraph.'),
    ),
  ).toBe(true);
});
