import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture } from '../fixture.js';
import * as A from '@automerge/automerge';

test('opening and closing preserves BOM and CRLF bytes', async () => {
  const original = '\ufeff# Heading\r\n\r\nText.\r\n';
  const { file, workspace, handle } = await fixture(original);
  expect(handle.doc().content).toBe('# Heading\n\nText.\n');
  await workspace.flush();
  expect(await readFile(file, 'utf8')).toBe(original);
  handle.change((doc) => A.splice(doc, ['content'], 2, 0, 'New '));
  await workspace.flush();
  expect(await readFile(file, 'utf8')).toBe('\ufeff# New Heading\r\n\r\nText.\r\n');
});

test('refuses to overwrite invalid UTF-8 and mixed line endings', async () => {
  const { file, workspace, handle } = await fixture();
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  await expect(workspace.flush()).rejects.toThrow();
  expect(await readFile(file)).toEqual(Buffer.from([0xff, 0xfe]));
  await writeFile(file, '# Mixed\r\nText\n');
  await workspace.flush();
  handle.change((doc) => A.splice(doc, ['content'], 0, 0, 'Local '));
  await expect(workspace.flush()).rejects.toThrow('Mixed line endings');
  await writeFile(file, '# Mixed\nText\n');
  await workspace.flush();
});
