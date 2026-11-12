import { cubicBezier } from 'motion/react';
import { DURATION } from './motion';

/**
 * Geometry of the follow glide (useFollowGlide): a reader pinned to the
 * bottom of a growing reply has scrollTop moved to the new bottom once per
 * batch, while the content layer is translated back down by the distance it
 * moved and eased to rest. The text glides up instead of jumping a few lines
 * at a time.
 */

export const FOLLOW_GLIDE_MS = DURATION.standard * 1000;
const FOLLOW_GLIDE_CURVE = [0.4, 0, 0.2, 1] as const;
export const FOLLOW_GLIDE_EASING = `cubic-bezier(${FOLLOW_GLIDE_CURVE.join(', ')})`;
const followEase = cubicBezier(...FOLLOW_GLIDE_CURVE);

/** One element's keyframe translations (px) over a glide, and easing. */
export interface GlideTrack {
  offsets: number[];
  easing: string;
}

/**
 * The track of a sticky row stuck to the top, `depth` px above where it
 * would sit in the content's flow, while the content glides up from `from`.
 * It is held against the content's translation for the whole glide when
 * stuck deeper than that, otherwise until the content catches up with it
 * (the glide in which it first sticks). A partial hold has no single easing,
 * so it is sampled.
 */
export function stickyTrack(from: number, depth: number): GlideTrack {
  if (depth >= from) {
    return { offsets: [-from, 0], easing: FOLLOW_GLIDE_EASING };
  }
  const steps = 16;
  return {
    offsets: Array.from(
      { length: steps + 1 },
      (_, i) => -Math.min(depth, from * (1 - followEase(i / steps))),
    ),
    easing: 'linear',
  };
}
