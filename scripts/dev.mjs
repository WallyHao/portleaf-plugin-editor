import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBuild } from './build-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let current = false;
try {
  await verifyBuild();
  current = true;
} catch {
  /* A missing or outdated build is rebuilt below. */
}
if (!current) {
  const child = spawn('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  if (code !== 0) process.exit(typeof code === 'number' ? code : 1);
}
await import('./launch.mjs');
