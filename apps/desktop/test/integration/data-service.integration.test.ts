import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { createDataService } from '../../src/data-service.js';

test('rejects pending initialization when the background data service exits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-worker-test-'));
  const executable = path.join(directory, 'worker.cjs');
  let service: ReturnType<typeof createDataService> | undefined;
  try {
    await build({
      stdin: {
        contents: `
      import { parentPort } from 'node:worker_threads';
      import { expose } from 'comlink';
      import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
      expose({ init: () => new Promise(() => {}), open: () => process.exit(2) }, nodeEndpoint(parentPort));
    `,
        resolveDir: path.resolve('apps/desktop'),
      },
      outfile: executable,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    service = createDataService(executable);
    const rejected = expect(service.init('', '', () => {})).rejects.toThrow(
      'Data service exited (2)',
    );
    void service.api.open('exit');
    await rejected;
  } finally {
    try {
      await service?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
