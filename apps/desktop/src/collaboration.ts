import { automergeSyncPlugin } from '@automerge/automerge-codemirror';
import { isReconcileTx } from '@automerge/automerge-codemirror/dist/plugin.js';
import { EditorState, Transaction } from '@codemirror/state';
import type { DocHandle } from '@automerge/automerge-repo';
import type { FileDoc } from '@portleaf/data-patchwork';

export function collaboration(handle: DocHandle<FileDoc>) {
  return [
    automergeSyncPlugin({ handle, path: ['content'] }),
    EditorState.transactionExtender.of((transaction) =>
      isReconcileTx(transaction)
        ? {
            annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
          }
        : null,
    ),
  ];
}

export function compositionSafePort(port: MessagePort) {
  let composing = false;
  let scheduled = false;
  const queued: MessageEvent[] = [];
  const listeners = new Set<EventListener>();
  port.addEventListener('message', (event) => {
    if (composing || scheduled) queued.push(event);
    else for (const listener of listeners) listener(event);
  });
  const start = () => {
    composing = true;
  };
  const end = () => {
    composing = false;
    scheduled = true;
    // Let CodeMirror commit the composition before delivering concurrent CRDT operations.
    setTimeout(() => {
      scheduled = false;
      if (!composing)
        for (const event of queued.splice(0)) for (const listener of listeners) listener(event);
    }, 0);
  };
  document.addEventListener('compositionstart', start, true);
  document.addEventListener('compositionend', end, true);
  window.addEventListener(
    'unload',
    () => {
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      port.close();
    },
    { once: true },
  );
  return {
    addEventListener(type: string, listener: EventListener) {
      if (type === 'message') listeners.add(listener);
    },
    // Electron's main-process ports accept cloned buffers, not web ArrayBuffer transfer lists.
    postMessage: (message: unknown) => port.postMessage(message),
    start: () => port.start(),
  } as unknown as MessagePort;
}
