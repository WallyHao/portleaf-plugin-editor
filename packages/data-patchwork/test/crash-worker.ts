import * as A from '@automerge/automerge';
import { Workspace, type FileDoc } from '../src/index.js';

void (async () => {
  const workspace = await Workspace.load(process.argv[2], process.argv[3]);
  const info = await workspace.open('note.md');
  const handle = await workspace.repo.find<FileDoc>(info.url);
  handle.change((doc) => A.splice(doc, ['content'], 0, 0, 'Durable before projection.\n'));
  await workspace.repo.flush([handle.documentId]);
  process.send?.('persisted');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
