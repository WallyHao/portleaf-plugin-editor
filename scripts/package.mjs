import { mkdtemp, mkdir, readFile, writeFile, cp, chmod, rm, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { projectRoot, sourceState } from './source-state.mjs';
import { verifyBuild } from './build-state.mjs';

if (process.platform !== 'linux') throw new Error('Linux packaging is currently supported.');
const metadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const stamp = await verifyBuild();
const source = await sourceState();
const epoch = process.env.SOURCE_DATE_EPOCH || '0';
if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be an integer timestamp.');
const name = `portleaf-${metadata.version}-linux-${process.arch}`;
const stage = await mkdtemp(path.join(os.tmpdir(), 'portleaf-package-'));
try {
  const directory = path.join(stage, name),
    application = path.join(directory, 'share/portleaf');
  await mkdir(path.join(directory, 'bin'), { recursive: true });
  await mkdir(application, { recursive: true });
  await cp(path.join(projectRoot, 'dist'), path.join(application, 'dist'), { recursive: true });
  const hashes = {};
  for (const output of stamp.outputs.sort()) {
    const file = path.join(projectRoot, 'dist', output);
    if (!(await lstat(file)).isFile()) continue;
    hashes[output] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  }
  await writeFile(
    path.join(application, 'package.json'),
    JSON.stringify({
      name: 'portleaf',
      version: metadata.version,
      main: 'dist/main.cjs',
      type: 'module',
    }) + '\n',
  );
  const launcher = path.join(directory, 'bin/portleaf');
  await cp(path.join(projectRoot, 'packaging/portleaf'), launcher);
  await chmod(launcher, 0o755);
  await mkdir(path.join(directory, 'share/applications'));
  await cp(
    path.join(projectRoot, 'packaging/portleaf.desktop'),
    path.join(directory, 'share/applications/portleaf.desktop'),
  );
  await cp(path.join(projectRoot, 'docs/distribution.md'), path.join(directory, 'README.md'));
  await writeFile(
    path.join(application, 'distribution.json'),
    JSON.stringify(
      {
        version: 1,
        applicationVersion: metadata.version,
        platform: process.platform,
        arch: process.arch,
        buildFingerprint: stamp.fingerprint,
        source,
        runtime: {
          electron: metadata.devDependencies.electron,
          coreutils: 'GNU mv with --no-copy and --update=none-fail',
        },
        hashes,
      },
      null,
      2,
    ) + '\n',
  );
  const output = path.join(projectRoot, 'release', `${name}.tar.gz`);
  if ((await sourceState()).fingerprint !== source.fingerprint)
    throw new Error('Sources changed while staging the distribution.');
  await mkdir(path.dirname(output), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      'tar',
      [
        '--sort=name',
        `--mtime=@${epoch}`,
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--mode=u+rwX,go+rX,go-w,a-s,a-t',
        '-I',
        'gzip -n',
        '-cf',
        output,
        '-C',
        stage,
        name,
      ],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited (${code}).`)),
    );
  });
  const digest = createHash('sha256')
    .update(await readFile(output))
    .digest('hex');
  await writeFile(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
