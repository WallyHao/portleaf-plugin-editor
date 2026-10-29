import { readFile, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildFingerprint } from './build-cache.mjs';
import { projectRoot } from './source-state.mjs';

export async function verifyBuild(application = projectRoot) {
  const stamp = JSON.parse(await readFile(path.join(application, 'dist/build.json'), 'utf8'));
  if (
    stamp.version !== 1 ||
    !stamp.hashes ||
    !Array.isArray(stamp.outputs) ||
    stamp.fingerprint !== (await buildFingerprint())
  )
    throw new Error('Build output is stale or lacks integrity metadata. Run pnpm build first.');
  for (const output of stamp.outputs) {
    if (
      typeof output !== 'string' ||
      path.isAbsolute(output) ||
      output.split(path.sep).includes('..')
    )
      throw new Error('Invalid build output path.');
    const file = path.join(application, 'dist', output),
      details = await lstat(file);
    if (details.isSymbolicLink())
      throw new Error(`Unexpected symbolic link in the build: ${output}`);
    if (details.isDirectory()) continue;
    if (
      stamp.hashes[output] !==
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex')
    )
      throw new Error(`Build output changed after compilation: ${output}`);
  }
  const actual = (await readdir(path.join(application, 'dist'), { recursive: true }))
    .filter((file) => file !== 'build.json')
    .sort();
  if (
    JSON.stringify(actual) !== JSON.stringify([...stamp.outputs].sort()) ||
    !['main.cjs', 'preload.cjs', 'data-worker.cjs', 'index.html', 'automerge_wasm_bg.wasm'].every(
      (file) => stamp.outputs.includes(file),
    )
  )
    throw new Error(
      'Build output inventory differs from its integrity metadata. Run pnpm build first.',
    );
  return stamp;
}
