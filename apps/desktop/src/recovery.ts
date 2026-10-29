import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '@portleaf/data-patchwork/storage';
import type { RecoveryDocument } from '@portleaf/core';

export function recoveryDocuments(value: unknown): RecoveryDocument[] {
  if (!Array.isArray(value)) throw new Error('Recovery documents must be an array.');
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof Reflect.get(entry, 'path') !== 'string' ||
      typeof Reflect.get(entry, 'text') !== 'string'
    )
      throw new Error('Invalid recovery document.');
    const doc = entry as RecoveryDocument;
    if (doc.url !== undefined && typeof doc.url !== 'string')
      throw new Error('Invalid recovery document URL.');
    if (
      doc.heads !== undefined &&
      (!Array.isArray(doc.heads) || !doc.heads.every((head) => typeof head === 'string'))
    )
      throw new Error('Invalid recovery document heads.');
    return {
      path: doc.path,
      text: doc.text,
      ...(doc.url ? { url: doc.url } : {}),
      ...(doc.heads ? { heads: doc.heads } : {}),
    };
  });
}

export async function writeRecovery(
  stateRoot: string,
  workspace: string,
  documents: RecoveryDocument[],
) {
  const unique = [...new Map(documents.map((doc) => [JSON.stringify(doc), doc])).values()];
  const createdAt = new Date().toISOString();
  const file = path.join(
    stateRoot,
    'recovery',
    `${createdAt.replaceAll(':', '-')}-${randomUUID()}.json`,
  );
  await atomicWrite(
    file,
    JSON.stringify({ version: 1, workspace, createdAt, documents: unique }, null, 2) + '\n',
  );
  return file;
}
