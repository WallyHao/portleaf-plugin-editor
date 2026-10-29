import { rm } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './source-state.mjs';

// Only reproducible project output belongs here; dependencies and user data stay outside cleanup.
const outputs = [
  'dist',
  'release',
  'artifacts',
  'test-results',
  'playwright-report',
  'coverage',
  '.cache',
];
for (const output of outputs) {
  await rm(path.join(projectRoot, output), { recursive: true, force: true });
  console.log(`Removed generated output: ${output}/`);
}
