import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sourceState, projectRoot } from './source-state.mjs';
import { verifyBuild } from './build-state.mjs';

const layer = process.argv[2];
if (!['all', 'unit', 'integration', 'e2e'].includes(layer))
  throw new Error('Use all, unit, integration or e2e.');
const extra = process.argv.slice(3);
const startedAt = new Date().toISOString();
const source = await sourceState();
const label =
  process.env.PORTLEAF_VALIDATION_LABEL ||
  (layer === 'all' ? 'vitest' : layer === 'e2e' ? 'electron' : layer);
if (!/^[a-z][a-z0-9-]*$/.test(label)) throw new Error('Invalid validation report label.');
const resultFile = path.join(projectRoot, 'test-results', `${label}.json`);
await mkdir(path.dirname(resultFile), { recursive: true });
let build = null,
  error = null,
  exitCode = 1;
try {
  if (layer === 'e2e') {
    const application = process.env.PORTLEAF_APP_PATH || projectRoot;
    build = await verifyBuild(application);
  }
  const args =
    layer === 'e2e'
      ? ['exec', 'playwright', 'test', ...extra]
      : [
          'exec',
          'vitest',
          'run',
          ...(layer === 'all' ? [] : ['--project', layer]),
          '--outputFile',
          resultFile,
          ...extra,
        ];
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, PORTLEAF_VALIDATION_LABEL: label },
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} catch (failure) {
  error = String(failure);
  console.error(error);
}
const after = await sourceState();
if (after.fingerprint !== source.fingerprint) {
  exitCode = 1;
  error = 'Sources changed during validation.';
}
await writeFile(
  path.join(projectRoot, 'test-results', `${label}-provenance.json`),
  JSON.stringify(
    {
      version: 1,
      layer,
      startedAt,
      finishedAt: new Date().toISOString(),
      source,
      buildFingerprint: build?.fingerprint ?? null,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        kernel: os.release(),
      },
      electron: process.env.PORTLEAF_ELECTRON ?? null,
      sandbox: process.env.PORTLEAF_SANDBOX === '1',
      application: process.env.PORTLEAF_APP_PATH ?? null,
      extraArguments: extra,
      resultFile,
      exitCode,
      error,
    },
    null,
    2,
  ) + '\n',
);
process.exitCode = exitCode;
