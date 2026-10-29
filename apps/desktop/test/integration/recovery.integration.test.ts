import { test, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoveryDocuments, writeRecovery } from '../../src/recovery.js';

test('recovery keeps distinct text versions privately without interpreting document names as output paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-recovery-'));
  try {
    const first = { path: '../../outside.md', text: 'Renderer 中文\n' };
    const second = { path: '../../outside.md', text: 'Worker version\n' };
    const file = await writeRecovery(
      directory,
      '/workspace',
      recoveryDocuments([first, second, first]),
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.documents).toEqual([first, second]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual(['recovery']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  null,
  {},
  [null],
  [{ path: 'note.md', text: 12 }],
  [{ path: 'note.md', text: 'Text', heads: [1] }],
])('rejects malformed recovery input %j', (input) => {
  expect(() => recoveryDocuments(input)).toThrow();
});
