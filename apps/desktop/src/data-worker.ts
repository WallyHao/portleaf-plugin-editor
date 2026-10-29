import { parentPort, type MessagePort } from 'node:worker_threads';
import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import { Workspace } from '@portleaf/data-patchwork';
import { MessageChannelNetworkAdapter } from '@automerge/automerge-repo-network-messagechannel';
import type { WorkspaceAPI } from './data-service.js';

let workspace: Workspace;
let network: MessageChannelNetworkAdapter | undefined;
let syncPort: MessagePort | undefined;
const api: WorkspaceAPI = {
  async init(root, stateRoot, notify) {
    workspace = await Workspace.load(root, stateRoot);
    workspace.on('status', (event) => {
      void notify(event);
    });
    return workspace.root;
  },
  connect(port) {
    network?.disconnect();
    syncPort?.close();
    syncPort = port;
    network = new MessageChannelNetworkAdapter(port as unknown as globalThis.MessagePort);
    workspace.repo.networkSubsystem.addNetworkAdapter(network);
  },
  list: (directory, options) => workspace.list(directory, options),
  browse: (directory, options) => workspace.browse(directory, options),
  preview: (file) => workspace.preview(file),
  mkdir: (directory) => workspace.mkdir(directory),
  copy: (file, target) => workspace.copy(file, target),
  open: (file, retain) => workspace.open(file, retain),
  create: (file, retain) => workspace.create(file, retain),
  release: (file, heads, url) => workspace.release(file, heads, url),
  releaseAll: () => workspace.releaseAll(),
  checkpoint: () => workspace.checkpoint(),
  recoverySnapshot: () => workspace.recoverySnapshot(),
  metrics: () => workspace.metrics(),
  rename: (file, target) => workspace.rename(file, target),
  imageFile: (file, target) => workspace.imageFile(file, target),
  resourceFile: (file) => workspace.resourceFile(file),
  inspect: (file) => workspace.inspect(file),
  watchResource: (file, enabled) => workspace.watchResource(file, enabled),
  awaitHeads: (url, heads) => workspace.awaitHeads(url, heads),
  flush: (urls) => workspace.flush(urls),
  history: (file) => workspace.history(file),
  restore: (file, heads) => workspace.restore(file, heads),
  rescan: () => workspace.rescan(),
  async close(options) {
    await workspace.close(options);
    syncPort?.close();
  },
};
expose(api, nodeEndpoint(parentPort!));
