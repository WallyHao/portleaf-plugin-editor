import { expect, test } from 'vitest';
import { byteRange } from '../../src/resource-range.js';

test('normalizes bounded, open-ended and suffix byte ranges and rejects unsatisfiable input', () => {
  expect(byteRange(null, 100)).toBeUndefined();
  expect(byteRange('bytes=0-3', 100)).toEqual({ start: 0, end: 3 });
  expect(byteRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
  expect(byteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
  expect(byteRange('bytes=0-65535', 100)).toEqual({ start: 0, end: 99 });
  for (const value of [
    'bytes=100-',
    'bytes=9-1',
    'bytes=-0',
    'bytes=0-1,3-4',
    'bytes=-',
    'bytes=999999999999999999999-',
  ])
    expect(byteRange(value, 100)).toBeNull();
  expect(byteRange('bytes=0-1', 0)).toBeNull();
});
