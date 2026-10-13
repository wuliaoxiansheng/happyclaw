import { describe, expect, it } from 'vitest';

import {
  formatThinkingDuration,
  thinkingLabel,
} from '../src/utils/thinking-duration';

describe('formatThinkingDuration', () => {
  it('reads short and long thoughts', () => {
    expect(formatThinkingDuration(3200)).toBe('已思考 3.2 秒');
    expect(formatThinkingDuration(14_000)).toBe('已思考 14 秒');
    expect(formatThinkingDuration(72_000)).toBe('已思考 1 分 12 秒');
    expect(formatThinkingDuration(120_000)).toBe('已思考 2 分');
    expect(formatThinkingDuration(0)).toBe('已思考 0 秒');
  });

  it('never reads 60 seconds: the minute boundary rounds first', () => {
    expect(formatThinkingDuration(59_400)).toBe('已思考 59 秒');
    expect(formatThinkingDuration(59_500)).toBe('已思考 1 分');
    expect(formatThinkingDuration(59_999)).toBe('已思考 1 分');
    // and a later boundary: 119.6 s is 2 minutes, not "1 分 60 秒"
    expect(formatThinkingDuration(119_600)).toBe('已思考 2 分');
  });

  it('labels under a second as plain reasoning', () => {
    expect(thinkingLabel(400)).toBe('思考过程');
    expect(thinkingLabel(undefined)).toBe('思考过程');
    expect(thinkingLabel(59_999)).toBe('已思考 1 分');
  });
});
