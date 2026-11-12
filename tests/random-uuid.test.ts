import { afterEach, describe, expect, test, vi } from 'vitest';

import { randomUuid } from '../web/src/utils/random-uuid.js';

const V4_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubInsecureContext(fill?: number): void {
  const nodeCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
      fill === undefined
        ? nodeCrypto.getRandomValues(array)
        : ((array as unknown as Uint8Array).fill(fill) as unknown as T),
  });
}

describe('randomUuid', () => {
  test('uses crypto.randomUUID when the page is a secure context', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(randomUuid()).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('builds distinct v4 UUIDs from getRandomValues without crypto.randomUUID', () => {
    stubInsecureContext();
    const ids = Array.from({ length: 64 }, () => randomUuid());
    for (const id of ids) expect(id).toMatch(V4_UUID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('forces the version and variant bits whatever the random bytes are', () => {
    stubInsecureContext(0xff);
    expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    stubInsecureContext(0x00);
    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
