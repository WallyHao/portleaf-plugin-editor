import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import path from 'node:path';
import { wrap, proxy, transfer, releaseProxy, type Remote } from 'comlink';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import type { MessagePortMain } from 'electron';
import type { Workspace, DataEvent } from '@portleaf/data-patchwork';
import { within } from './requests.js';

export type WorkspaceAPI = Pick<
  Workspace,
  | 'list'
  | 'browse'
  | 'preview'
  | 'mkdir'
  | 'copy'
  | 'open'
  | 'create'
  | 'rename'
  | 'imageFile'
  | 'resourceFile'
  | 'inspect'
  | 'watchResource'
  | 'release'
  | 'releaseAll'
  | 'checkpoint'
  | 'recoverySnapshot'
  | 'metrics'
  | 'awaitHeads'
  | 'flush'
  | 'history'
  | 'restore'
  | 'rescan'
  | 'close'
> & {
  init(root: string, stateRoot: string, notify: (event: DataEvent) => void): Promise<string>;
  connect(port: MessagePort): void;
};

export function createDataService(executable = path.join(__dirname, 'data-worker.cjs')) {
  const worker = new Worker(executable);
  const api = wrap<WorkspaceAPI>(nodeEndpoint(worker));
  let stopping = false;
  let disposal: Promise<void> | undefined;
  let rejectFailure!: (error: Error) => void;
  let closeBridge: (() => void) | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!stopping) reject(new Error(`Data service exited (${code}).`));
    });
  });
  // Callers race requests against failure so a terminated worker cannot leave IPC pending forever.
  void failure.catch(() => {});
  return {
    api,
    failure,
    init: (root: string, stateRoot: string, notify: (event: DataEvent) => void) =>
      within(
        Promise.race([api.init(root, stateRoot, proxy(notify)), failure]),
        30_000,
        'Workspace initialization',
      ),
    async connect(port: MessagePortMain) {
      closeBridge?.();
      const channel = new MessageChannel();
      port.on('message', (event) => channel.port1.postMessage(event.data));
      channel.port1.on('message', (data) => port.postMessage(data));
      closeBridge = () => {
        channel.port1.close();
        port.close();
      };
      port.start();
      await Promise.race([api.connect(transfer(channel.port2, [channel.port2])), failure]);
    },
    dispose() {
      if (disposal) return disposal;
      stopping = true;
      rejectFailure(new Error('Data service closed.'));
      disposal = (async () => {
        closeBridge?.();
        try {
          api[releaseProxy]();
        } finally {
          await worker.terminate();
        }
      })();
      return disposal;
    },
  };
}

export type DataService = ReturnType<typeof createDataService>;
export type WorkspaceRemote = Remote<WorkspaceAPI>;
