import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { canDeleteAcknowledgedIpcSource } from '../src/host-ipc-output-router.js';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');

/** Slice from the invalid-message gate through the frozen-mode early exit. */
function messageEarlyExitRegion(source: string): string {
  const start = source.indexOf("error: 'Invalid message request.'");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(
    "error: 'Invalid frozen interaction mode.'",
    start,
  );
  expect(end).toBeGreaterThan(start);
  const after = source.indexOf('continue;', end);
  expect(after).toBeGreaterThan(end);
  return source.slice(start, after + 'continue;'.length);
}

function assertGuardedUnlink(region: string, errorLiteral: string): void {
  const errAt = region.indexOf(errorLiteral);
  expect(errAt).toBeGreaterThanOrEqual(0);
  const fenceAt = region.indexOf('canDeleteAcknowledgedIpcSource(', errAt);
  const unlinkAt = region.indexOf('await fsp.unlink(filePath);', errAt);
  expect(fenceAt).toBeGreaterThan(errAt);
  expect(unlinkAt).toBeGreaterThan(fenceAt);
}

describe('send_message early-exit ACK fence', () => {
  test('invalid / frozen message paths fence unlink like image', () => {
    const region = messageEarlyExitRegion(indexSource);
    assertGuardedUnlink(region, "error: 'Invalid message request.'");
    assertGuardedUnlink(region, "error: 'Invalid frozen interaction mode.'");

    // Image invalid path already had the fence — keep the asymmetry closed.
    const imageInvalid = indexSource.indexOf("error: 'Invalid image request.'");
    expect(imageInvalid).toBeGreaterThanOrEqual(0);
    expect(
      indexSource.indexOf('canDeleteAcknowledgedIpcSource(', imageInvalid),
    ).toBeGreaterThan(imageInvalid);
  });

  test('live fail-then-pass: requestId present and result write failed blocks delete', () => {
    // Mirrors writeIpcMessageResult returning false (ENOSPC / bad id / rename).
    expect(canDeleteAcknowledgedIpcSource('req-1', false)).toBe(false);
    expect(canDeleteAcknowledgedIpcSource('req-1', true)).toBe(true);
    expect(canDeleteAcknowledgedIpcSource(undefined, false)).toBe(true);
  });
});
