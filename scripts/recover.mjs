import { readFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: pnpm recover <recovery.json> <new-directory>');
const snapshot = JSON.parse(await readFile(input, 'utf8'));
if (
  !snapshot ||
  typeof snapshot !== 'object' ||
  snapshot.version !== 1 ||
  !Array.isArray(snapshot.documents) ||
  !snapshot.documents.every(
    (doc) => doc && typeof doc.path === 'string' && typeof doc.text === 'string',
  )
)
  throw new Error('Invalid recovery file. No output was written.');
const directory = path.resolve(output);
await mkdir(directory, { mode: 0o700 });
const manifest = [];
for (const [index, document] of snapshot.documents.entries()) {
  const base = path.basename(document.path).replace(/[^\p{L}\p{N}._-]/gu, '_') || 'document.txt';
  const name = `${String(index + 1).padStart(4, '0')}-${base}`;
  const file = await open(path.join(directory, name), 'wx', 0o600);
  try {
    await file.writeFile(document.text);
    await file.sync();
  } finally {
    await file.close();
  }
  manifest.push({
    recoveredFile: name,
    originalPath: document.path,
    url: document.url,
    heads: document.heads,
  });
}
const file = await open(path.join(directory, 'recovery-index.json'), 'wx', 0o600);
try {
  await file.writeFile(
    JSON.stringify({ workspace: snapshot.workspace, documents: manifest }, null, 2) + '\n',
  );
  await file.sync();
} finally {
  await file.close();
}
const parent = await open(directory, 'r');
try {
  await parent.sync();
} finally {
  await parent.close();
}
console.log(directory);
