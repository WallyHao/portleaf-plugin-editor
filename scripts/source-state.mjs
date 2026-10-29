import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function sourceState() {
  const files = [];
  const excluded = new Set([
    '.git',
    '.agents',
    '.codex',
    '.aws',
    'node_modules',
    'dist',
    'artifacts',
    'test-results',
    'playwright-report',
    'release',
    '.cache',
    '.direnv',
    'coverage',
  ]);
  async function visit(directory = '') {
    for (const entry of await readdir(path.join(projectRoot, directory), { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name === 'result' || entry.name.startsWith('result-'))
        continue;
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await visit();
  const hash = createHash('sha256');
  for (const file of files.sort())
    hash
      .update(file)
      .update('\0')
      .update(await readFile(path.join(projectRoot, file)))
      .update('\0');
  return {
    fingerprint: hash.digest('hex'),
    files: files.length,
    revision: process.env.GITHUB_SHA ?? null,
  };
}
