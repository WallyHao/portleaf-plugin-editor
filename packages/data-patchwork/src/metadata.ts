import path from 'node:path';
import { isValidAutomergeUrl, type AutomergeUrl, type UrlHeads } from '@automerge/automerge-repo';
import type { Format } from './format.js';

export type Projection = { hash: string; heads: UrlHeads; format: Format };
export type RecordEntry = {
  url: AutomergeUrl;
  base: Projection;
  deleted?: boolean;
  pending?: Projection;
};
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const relativePath = (file: unknown): file is string =>
  typeof file === 'string' &&
  file.length > 0 &&
  file !== '.' &&
  !path.isAbsolute(file) &&
  !file.split(path.sep).some((part) => part === '..' || part === '') &&
  path.normalize(file) === file;

function projection(value: unknown): value is Projection {
  return (
    object(value) &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    Array.isArray(value.heads) &&
    value.heads.every((head) => typeof head === 'string') &&
    object(value.format) &&
    typeof value.format.bom === 'boolean' &&
    typeof value.format.mixed === 'boolean' &&
    (value.format.eol === '\n' || value.format.eol === '\r\n')
  );
}
export function record(value: unknown): value is RecordEntry {
  return (
    object(value) &&
    typeof value.url === 'string' &&
    isValidAutomergeUrl(value.url) &&
    projection(value.base) &&
    (value.pending === undefined || projection(value.pending)) &&
    (value.deleted === undefined || typeof value.deleted === 'boolean')
  );
}
export function parseIndex(source: string): Record<string, RecordEntry> {
  const value: unknown = JSON.parse(source);
  if (
    !object(value) ||
    !Object.entries(value).every(([file, entry]) => relativePath(file) && record(entry))
  )
    throw new Error('Invalid workspace index. Keep the store for recovery; do not delete it.');
  return Object.assign(Object.create(null), value);
}
