import { build as vite } from 'vite';
import { build as esbuild } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFile, writeFile, readdir, readFile, lstat, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildFingerprint } from './build-cache.mjs';
import { createRequire } from 'node:module';
import wasm from 'vite-plugin-wasm';

const root = fileURLToPath(new URL('../', import.meta.url));
const fingerprint = await buildFingerprint();
await vite({
  root: root + 'apps/desktop',
  base: './',
  plugins: [wasm()],
  worker: {
    plugins: () => [
      {
        name: 'worker-character-entities',
        enforce: 'pre',
        resolveId(id, importer) {
          // Its browser export uses document; the default export is Worker-compatible.
          if (id === 'decode-named-character-reference' && importer)
            return createRequire(importer).resolve(id);
        },
      },
    ],
  },
  build: { outDir: root + 'dist', emptyOutDir: true, target: 'esnext' },
  resolve: { dedupe: ['@codemirror/state', '@codemirror/view', '@automerge/automerge'] },
});
await esbuild({
  entryPoints: [
    'apps/desktop/src/main.ts',
    'apps/desktop/src/preload.ts',
    'apps/desktop/src/data-worker.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  sourcemap: true,
});
const require = createRequire(root + 'apps/desktop/package.json');
const pluginRequire = createRequire(root + 'packages/plugins/package.json');
const pdfRoot = fileURLToPath(
  new URL('./', pathToFileURL(pluginRequire.resolve('pdfjs-dist/package.json'))),
);
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
  await cp(pdfRoot + directory, root + 'dist/pdfjs/' + directory, { recursive: true });
await copyFile(pdfRoot + 'LICENSE', root + 'dist/pdfjs/LICENSE');
await copyFile(
  require.resolve('@automerge/automerge/automerge.wasm'),
  root + 'dist/automerge_wasm_bg.wasm',
);

const outputs = await readdir(root + 'dist', { recursive: true });
const hashes = {};
for (const output of outputs.sort()) {
  const file = root + 'dist/' + output;
  if ((await lstat(file)).isFile())
    hashes[output] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
}
if (fingerprint !== (await buildFingerprint()))
  throw new Error('Sources changed during compilation. Rebuild before launching.');
await writeFile(
  root + 'dist/build.json',
  JSON.stringify({ version: 1, fingerprint, outputs, hashes }) + '\n',
);
