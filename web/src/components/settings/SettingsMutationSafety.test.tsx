import { describe, expect, test } from 'vitest';

import { createAppearanceMutationQueue } from './AppearanceSection';

async function expectSerialized(
  createQueue: () => <T>(request: () => Promise<T>) => Promise<T>,
) {
  const calls: string[] = [];
  let releaseFirst!: (value: string) => void;
  const firstResponse = new Promise<string>((resolve) => {
    releaseFirst = resolve;
  });
  const enqueue = createQueue();

  const first = enqueue(async () => {
    calls.push('first-start');
    const value = await firstResponse;
    calls.push('first-finish');
    return value;
  });
  const second = enqueue(async () => {
    calls.push('second-start');
    return 'newer';
  });

  await Promise.resolve();
  expect(calls).toEqual(['first-start']);

  releaseFirst('older');
  await expect(first).resolves.toBe('older');
  await expect(second).resolves.toBe('newer');
  expect(calls).toEqual(['first-start', 'first-finish', 'second-start']);
}

describe('settings mutation sequencing', () => {
  test('serializes appearance snapshots submitted concurrently', async () => {
    await expectSerialized(createAppearanceMutationQueue);
  });
});
