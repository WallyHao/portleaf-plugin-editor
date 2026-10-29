import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { electronPath } from '../../../scripts/electron-path.mjs';
import { stopProcess } from '../../support/process.js';

type DesktopOptions = {
  content?: string;
  config?: Record<string, unknown>;
  configSource?: string;
  files?: Record<string, string | Buffer>;
  checkConsoleErrors?: boolean;
  application?: string;
};
type DesktopHarness = {
  directory: string;
  root: string;
  config: string;
  file: string;
  errors: string[];
  readonly desktop: ElectronApplication;
  readonly page: Page;
  readonly child: ChildProcess;
  restart(initialFile: string, stateDirectory?: string, application?: string): Promise<void>;
};

export const test = base.extend<{ app: DesktopHarness; desktopOptions: DesktopOptions }>({
  desktopOptions: [{}, { option: true }],
  app: async ({ desktopOptions }, use, testInfo) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'portleaf-e2e-'));
    const root = path.join(directory, 'notes');
    const config = path.join(directory, 'config');
    const file = path.join(root, 'note.md');
    const errors: string[] = [];
    const consoleMessages: string[] = [];
    let desktop: ElectronApplication | undefined;
    let child: ChildProcess | undefined;
    let page: Page | undefined;
    const monitored = new WeakSet<Page>();
    const monitor = (window: Page) => {
      if (monitored.has(window)) return;
      monitored.add(window);
      window.on('pageerror', (error) => errors.push(error.message));
      window.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (consoleMessages.length < 100) consoleMessages.push(message.text());
        if (desktopOptions.checkConsoleErrors !== false) errors.push(message.text());
      });
    };
    const restart = async (
      initialFile: string,
      stateDirectory = 'state',
      application = desktopOptions.application ??
        process.env.PORTLEAF_APP_PATH ??
        path.resolve('.'),
    ) => {
      if (child) await stopProcess(child, 'Electron');
      desktop = await electron.launch({
        executablePath: electronPath(),
        args: [
          ...(process.env.PORTLEAF_SANDBOX === '1' ? [] : ['--no-sandbox']),
          '--ozone-platform=x11',
          '--disable-gpu',
          application,
        ],
        env: {
          ...process.env,
          PORTLEAF_WORKSPACE: path.join(root, initialFile),
          PORTLEAF_CONFIG_HOME: config,
          PORTLEAF_STATE_HOME: path.join(directory, stateDirectory),
          XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
        },
      });
      // Playwright releases ElectronApplication's process channel after normal exit.
      // Keep the Node handle for exit assertions and cleanup throughout the fixture.
      child = desktop.process();
      desktop.on('window', monitor);
      page = await desktop.firstWindow();
      monitor(page);
    };
    try {
      await mkdir(root);
      await mkdir(config);
      await writeFile(
        file,
        desktopOptions.content ?? '# Heading\n\nFirst paragraph.\n\nLast paragraph.\n',
      );
      for (const [name, content] of Object.entries(desktopOptions.files ?? {})) {
        const target = path.join(root, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      await writeFile(
        path.join(config, 'config.json'),
        desktopOptions.configSource ??
          JSON.stringify({
            fontSize: 18,
            fontFamily: 'monospace',
            theme: 'minimal',
            ...desktopOptions.config,
          }),
      );
      await restart('note.md');
      await expect(page!.getByLabel('note.md', { exact: true })).toBeVisible();
      await use({
        directory,
        root,
        config,
        file,
        errors,
        get desktop() {
          return desktop!;
        },
        get page() {
          return page!;
        },
        get child() {
          return child!;
        },
        restart,
      });
    } finally {
      const failures: unknown[] = [];
      try {
        if (child) await stopProcess(child, 'Electron');
      } catch (error) {
        failures.push(error);
      }
      try {
        // Keep live process files available if termination itself failed.
        if (!child || child.exitCode !== null || child.signalCode !== null)
          await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        failures.push(error);
      }
      if (errors.length || consoleMessages.length) {
        try {
          await testInfo.attach('renderer-diagnostics', {
            body: JSON.stringify({ errors, consoleMessages }, null, 2),
            contentType: 'application/json',
          });
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        expect(errors, 'Unexpected renderer errors').toEqual([]);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, 'Electron fixture cleanup failed.');
    }
  },
});

export { expect };

export async function capture(page: Page, name: string) {
  const info = test.info();
  const screenshot = await page.screenshot({ path: info.outputPath(`${name}.png`) });
  await info.attach(name, { body: screenshot, contentType: 'image/png' });
}

export async function acceptPicker(page: Page) {
  await page.keyboard.press('Enter');
}
export async function dismissPicker(page: Page) {
  await page.keyboard.press('Escape');
  if (await page.getByLabel('Quick picker').isVisible()) await page.keyboard.press('Escape');
}
export async function searchPicker(page: Page, query: string) {
  await page.keyboard.press('/');
  await page.getByLabel('Filter').fill(query);
}
export async function submitName(page: Page, name: string) {
  await page.getByLabel('Filter').fill(name);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Quick picker')).toBeHidden();
}
