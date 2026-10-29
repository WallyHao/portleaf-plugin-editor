import { afterEach, expect, test, vi } from 'vitest';
import { within, RequestTimeout } from '../../src/requests.js';

afterEach(() => vi.useRealTimers());

test('a completed data request cancels its deadline', async () => {
  vi.useFakeTimers();
  expect(await within(Promise.resolve('saved'), 1000, 'Save')).toBe('saved');
  expect(vi.getTimerCount()).toBe(0);
});

test('an unavailable data request rejects at its deadline and releases its timer', async () => {
  vi.useFakeTimers();
  const pending = within(new Promise<never>(() => {}), 1000, 'Save');
  const failure = expect(pending).rejects.toBeInstanceOf(RequestTimeout);
  await vi.advanceTimersByTimeAsync(1000);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
