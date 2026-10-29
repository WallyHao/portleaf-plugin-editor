import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildFingerprint() {
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'scripts/build.mjs',
    'scripts/build-cache.mjs',
  ];
  async function visit(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (['node_modules', 'dist', 'test'].includes(entry.name)) continue;
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (/\.(ts|css|html|json)$/.test(entry.name) && !entry.name.endsWith('.test.ts'))
        files.push(relative);
    }
  }
  await Promise.all(['apps', 'packages'].map(visit));
  const hash = createHash('sha256');
  for (const file of files.sort())
    hash
      .update(file)
      .update('\0')
      .update(await readFile(path.join(root, file)));
  return hash.digest('hex');
}
