import { cubicBezier } from 'motion/react';
import { describe, expect, test } from 'vitest';
import { stickyTrack } from './follow-glide';

describe('stickyTrack', () => {
  /** Where an element shows at `progress`, linearly between keyframes. */
  function sample(offsets: number[], progress: number): number {
    const at = progress * (offsets.length - 1);
    const i = Math.min(Math.floor(at), offsets.length - 2);
    return offsets[i] + (offsets[i + 1] - offsets[i]) * (at - i);
  }

  test('a row stuck deeper than the glide is held for all of it', () => {
    expect(stickyTrack(64, 300)).toEqual({
      offsets: [-64, 0],
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    });
    expect(stickyTrack(64, 64).offsets).toEqual([-64, 0]);
  });

  test('a row that sticks during the glide is held only once the content passes it', () => {
    const from = 66;
    const depth = 28;
    // The content's own track, on the glide's CSS easing.
    const ease = cubicBezier(0.4, 0, 0.2, 1);
    const { offsets, easing } = stickyTrack(from, depth);
    expect(easing).toBe('linear');
    expect(offsets[0]).toBe(-depth);
    expect(offsets.at(-1)).toBeCloseTo(0, 10);
    for (let i = 0; i <= 40; i += 1) {
      const progress = i / 40;
      const content = from * (1 - ease(progress));
      // On screen: where the flow puts it (content offset, `depth` above the
      // stuck spot) or the stuck spot, whichever is lower.
      const shown = content + sample(offsets, progress);
      expect(shown).toBeCloseTo(Math.max(content - depth, 0), 0);
    }
  });
});
