import { test, expect } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resourceResponse } from '../../src/resource-response.js';

test('serves exact byte ranges from one open file and rejects a substituted symbolic link', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-resource-'));
  try {
    const file = path.join(directory, 'book.pdf');
    await writeFile(file, '%PDF-range-content');
    const response = await resourceResponse(
      file,
      new Request('https://local.test', { headers: { Range: 'bytes=0-3' } }),
      true,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-3/18');
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF');
    const alias = path.join(directory, 'alias.pdf');
    await symlink(file, alias);
    await expect(
      resourceResponse(alias, new Request('https://local.test'), true),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serves an empty resource and an unsatisfiable range without retaining open streams', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-empty-resource-'));
  try {
    const file = path.join(directory, 'empty.pdf');
    await writeFile(file, '');
    const empty = await resourceResponse(file, new Request('https://local.test'), true);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe('');
    const range = await resourceResponse(
      file,
      new Request('https://local.test', { headers: { Range: 'bytes=0-3' } }),
      true,
    );
    expect(range.status).toBe(416);
    expect(range.headers.get('Content-Range')).toBe('bytes */0');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
