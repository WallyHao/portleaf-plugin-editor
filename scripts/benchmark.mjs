import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { electronPath } from './electron-path.mjs';
import { sourceState } from './source-state.mjs';

const label = process.argv[2] || 'current';
if (!/^[a-z][a-z0-9-]*$/.test(label)) throw new Error('Invalid benchmark label.');
await mkdir('artifacts', { recursive: true });
const executable = path.resolve(process.argv[3] || 'dist/main.cjs');
const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-bench-'));
const root = path.join(directory, 'notes');
await mkdir(root);
// A project-like tree tests watcher scope; visible notes test list navigation.
for (let folder = 0; folder < 160; folder++) {
  const target = path.join(root, 'node_modules', `package-${folder}`);
  await mkdir(target, { recursive: true });
  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeFile(path.join(target, `${index}.js`), 'export default 1;\n'),
    ),
  );
}
await Promise.all(
  Array.from({ length: 1200 }, (_, index) =>
    writeFile(path.join(root, `note-${String(index).padStart(4, '0')}.md`), '# Note\n\nText.\n'),
  ),
);
const longText = Array.from(
  { length: 400 },
  (_, index) =>
    `## Section ${index}\n\nParagraph with **bold**, *emphasis*, and [a link](https://example.com).\n\n- [ ] A task\n\nEquation: $x_${index}^2 + y^2$.\n\n`,
).join('');
await writeFile(path.join(root, 'long.md'), longText);
const results = {
  label,
  source: await sourceState(),
  build: JSON.parse(await readFile(path.join(path.dirname(executable), 'build.json'), 'utf8')),
  fixture: {
    dependencyFiles: 4800,
    visibleNotes: 1201,
    longNoteBytes: Buffer.byteLength(longText),
  },
  runs: [],
};
async function run(mode, iteration) {
  const config = path.join(directory, `${mode}-${iteration}`);
  await mkdir(config);
  await writeFile(
    path.join(config, 'config.json'),
    JSON.stringify({ theme: 'minimal', fontFamily: 'monospace', fontSize: 14 }),
  );
  const start = performance.now();
  const desktop = await electron.launch({
    executablePath: electronPath(),
    args: ['--no-sandbox', '--ozone-platform=x11', '--disable-gpu', executable],
    env: {
      ...process.env,
      PORTLEAF_WORKSPACE: mode === 'directory' ? root : path.join(root, 'long.md'),
      PORTLEAF_STATE_HOME: path.join(config, 'state'),
      PORTLEAF_CONFIG_HOME: config,
    },
  });
  try {
    const page = await desktop.firstWindow();
    const target =
      mode === 'directory'
        ? '[aria-label="File selector"]:not([hidden]) [role="option"]'
        : '[aria-label="long.md"]';
    await page.locator(target).first().waitFor({ state: 'visible', timeout: 60_000 });
    const readyMs = performance.now() - start;
    const initial = await desktop.evaluate(() => ({
      cpu: process.cpuUsage(),
      resources: process.getActiveResourcesInfo(),
    }));
    await page.waitForTimeout(1500);
    const settled = await desktop.evaluate(() => ({
      cpu: process.cpuUsage(),
      resources: process.getActiveResourcesInfo(),
    }));
    let profile;
    if (process.env.PORTLEAF_CPU_PROFILE && mode === 'long-note') {
      profile = await page.context().newCDPSession(page);
      await profile.send('Profiler.enable');
      await profile.send('Profiler.start');
      await desktop.evaluate(async () => {
        const { Session } = process.getBuiltinModule('node:inspector');
        const session = (globalThis.portleafCpuSession = new Session());
        session.connect();
        await new Promise((resolve, reject) =>
          session.post('Profiler.enable', (error) => (error ? reject(error) : resolve())),
        );
        await new Promise((resolve, reject) =>
          session.post('Profiler.start', (error) => (error ? reject(error) : resolve())),
        );
      });
    }
    let interaction;
    if (mode === 'directory')
      interaction = await page.evaluate(async () => {
        const panel = document.querySelector('[aria-label="File selector"]');
        const samples = [];
        for (let index = 0; index < 40; index++) {
          const start = performance.now();
          panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
          await new Promise(requestAnimationFrame);
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        return {
          p50Ms: samples[20],
          p95Ms: samples[38],
          renderedRows: panel.querySelectorAll('[role="option"]').length,
        };
      });
    else {
      await page.keyboard.press('i');
      await page.evaluate(() => {
        window.portleafInputTimings = [];
        document.querySelector('[aria-label="long.md"]').addEventListener(
          'beforeinput',
          () => {
            const start = performance.now();
            requestAnimationFrame(() =>
              window.portleafInputTimings.push(performance.now() - start),
            );
          },
          true,
        );
      });
      const samples = [];
      for (let index = 0; index < 12; index++) {
        const start = performance.now();
        await page.keyboard.insertText('x');
        await page.evaluate(() => new Promise(requestAnimationFrame));
        samples.push(performance.now() - start);
      }
      const ordered = [...samples];
      samples.sort((a, b) => a - b);
      interaction = {
        p50Ms: samples[6],
        p95Ms: samples[11],
        samplesMs: ordered,
        rendererInputMs: await page.evaluate(() => window.portleafInputTimings),
      };
    }
    if (profile) {
      const main = await desktop.evaluate(async () => {
        const session = globalThis.portleafCpuSession;
        const result = await new Promise((resolve, reject) =>
          session.post('Profiler.stop', (error, result) =>
            error ? reject(error) : resolve(result),
          ),
        );
        session.disconnect();
        delete globalThis.portleafCpuSession;
        return result;
      });
      await writeFile(
        path.resolve(`artifacts/main-${label}-${iteration}.cpuprofile`),
        JSON.stringify(main.profile),
      );
      const result = await profile.send('Profiler.stop');
      await writeFile(
        path.resolve(`artifacts/renderer-${label}-${iteration}.cpuprofile`),
        JSON.stringify(result.profile),
      );
    }
    const record = {
      mode,
      iteration,
      readyMs,
      mainCpuAfterReadyMs:
        (settled.cpu.user + settled.cpu.system - initial.cpu.user - initial.cpu.system) / 1000,
      fileWatchHandles: settled.resources.filter((item) => item === 'FSEventWrap').length,
      interaction,
      workspace: await page.evaluate(() => window.portleaf.diagnostics?.() ?? null),
    };
    if (process.env.PORTLEAF_BENCH_LIFECYCLE && iteration === 1) {
      const count = Number(process.env.PORTLEAF_BENCH_LIFECYCLE);
      if (!Number.isInteger(count) || count < 1 || count > 500)
        throw new Error('Lifecycle samples must be 1–500.');
      const samples = [];
      await page.keyboard.press('Escape');
      for (let index = 0; index < count; index++) {
        const file = `note-${String(index).padStart(4, '0')}.md`;
        const start = performance.now();
        await page.keyboard.type(' ft');
        await page.getByLabel('Quick picker').locator('input').fill(file);
        await page.keyboard.press('Enter');
        await page.getByLabel(file, { exact: true }).waitFor({ state: 'visible' });
        await page.keyboard.type(' bd');
        await page.getByLabel(file, { exact: true }).waitFor({ state: 'hidden' });
        if ((index + 1) % 10 === 0 || index + 1 === count)
          samples.push({
            openedAndClosed: index + 1,
            lastCycleMs: performance.now() - start,
            workspace: await page.evaluate(() => window.portleaf.diagnostics()),
            editorViews: await page.locator('.cm-editor').count(),
            browserRssBytes: await desktop.evaluate(() => process.memoryUsage().rss),
          });
      }
      record.lifecycle = samples;
    }
    results.runs.push(record);
    console.log(JSON.stringify(record));
  } finally {
    const child = desktop.process();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
}
try {
  for (const mode of ['directory', 'long-note'])
    for (let iteration = 1; iteration <= Number(process.env.PORTLEAF_BENCH_RUNS || 3); iteration++)
      await run(mode, iteration);
  await writeFile(
    path.resolve(`artifacts/performance-${label}.json`),
    JSON.stringify(results, null, 2) + '\n',
  );
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
