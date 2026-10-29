import { expect, test } from 'vitest';
import { fitScale, textMatches, viewerOptions } from '../../../src/media-viewer/model.js';

test('fits portrait and landscape documents, bounds manual zoom, and ignores invalid preferences', () => {
  expect(fitScale('fit', 600, 800, 1200, 400, 1)).toBe(0.5);
  expect(fitScale('width', 800, 600, 400, 900, 1)).toBe(0.5);
  expect(fitScale('actual', 600, 800, 400, 400, 2)).toBe(1);
  expect(fitScale('manual', 600, 800, 400, 400, 100)).toBe(16);
  expect(
    viewerOptions({ zoomStep: NaN, maxCanvasPixels: Infinity, imageBackground: 'invalid' }),
  ).toEqual(viewerOptions(undefined));
});

test('searches literal text with original UTF-16 offsets, case-insensitively and with a result bound', () => {
  expect(textMatches('A [x]. a [X].', '[x].')).toEqual([2, 9]);
  expect(textMatches('中文 αİ Z😀ab', 'ab')).toEqual([9]);
  expect(textMatches('a a a', 'a', 2)).toEqual([0, 2]);
  expect(textMatches('abc', '')).toEqual([]);
});

test('PDF rasterization caps both total pixels and the longest canvas side', async () => {
  const { rasterScale } = await import('../../../src/media-viewer/model.js');
  const ratio = rasterScale(10000, 20000, 2, 16000000);
  expect(Math.floor(10000 * ratio) * Math.floor(20000 * ratio)).toBeLessThanOrEqual(16000000);
  const wide = rasterScale(1000000, 1, 2, 16000000);
  expect(Math.floor(1000000 * wide)).toBeLessThanOrEqual(16384);
});
