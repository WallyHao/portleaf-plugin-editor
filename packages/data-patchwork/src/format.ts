import { createHash } from 'node:crypto';

export type Format = { bom: boolean; eol: '\n' | '\r\n'; mixed: boolean };
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function decode(bytes: Uint8Array): { text: string; format: Format } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bom ? bytes.slice(3) : bytes,
  );
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(raw))
    throw new Error('This file contains binary data.');
  const crlf = raw.includes('\r\n');
  const withoutCRLF = raw.replaceAll('\r\n', '');
  if (withoutCRLF.includes('\r')) throw new Error('Standalone carriage returns are not supported.');
  return {
    text: raw.replaceAll('\r\n', '\n'),
    format: { bom, eol: crlf ? '\r\n' : '\n', mixed: crlf && withoutCRLF.includes('\n') },
  };
}

export function encode(text: string, format: Format): Buffer {
  if (format.mixed)
    throw new Error(
      'Mixed line endings: editing is kept in history; normalize the file externally to resume export.',
    );
  return Buffer.from((format.bom ? '\ufeff' : '') + text.replaceAll('\n', format.eol));
}
