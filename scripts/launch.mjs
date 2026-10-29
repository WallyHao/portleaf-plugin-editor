import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { electronPath } from './electron-path.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(electronPath(), [root, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
