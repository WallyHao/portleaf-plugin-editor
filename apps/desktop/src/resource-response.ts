import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { byteRange } from './resource-range.js';

const types: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export async function resourceResponse(file: string, request: Request, cors: boolean) {
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await descriptor.stat();
    if (!details.isFile()) throw new Error('Choose a regular resource file.');
    const range = byteRange(request.headers.get('Range'), details.size);
    if (range === null) {
      await descriptor.close();
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${details.size}` },
      });
    }
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(range ? range.end - range.start + 1 : details.size),
    });
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${details.size}`);
    if (cors) {
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
      headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    if (!details.size) {
      await descriptor.close();
      return new Response(null, { headers });
    }
    const stream = descriptor.createReadStream({
      ...(range ? { start: range.start, end: range.end } : {}),
      autoClose: true,
    });
    const abort = () => stream.destroy(new Error('Resource request cancelled.'));
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    if (request.signal.aborted) abort();
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    await descriptor.close().catch(() => {});
    throw error;
  }
}
