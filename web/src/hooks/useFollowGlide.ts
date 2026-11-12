import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import {
  FOLLOW_GLIDE_EASING,
  FOLLOW_GLIDE_MS,
  stickyTrack,
  type GlideTrack,
} from '../lib/follow-glide';

/**
 * Keeps a reader pinned to the bottom of `scroller` there as the content
 * grows. A smooth follow writes scrollTop once and lets `layer` glide up from
 * where it showed, on the compositor (see follow-glide); a batch arriving
 * mid-glide retargets from where the content currently shows. The transform
 * is invisible to layout, so row measurements, offsetHeight and scrollTop are
 * untouched; `layer` must sit in a box that clips it vertically, or the
 * translation would add scroll range below the content. Rows in
 * `stickyScope` matching `stickySelector` that are stuck to the top stay
 * there while the content glides under them; in flow they sit at the top of
 * their parent.
 */
export function useFollowGlide(
  scrollerRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  stickyScopeRef: RefObject<HTMLElement | null>,
  stickySelector: string,
) {
  const glideRef = useRef<Animation[] | null>(null);
  // scrollTop as last shown. A shrink that clamps scrollTop and a regrowth
  // in the same frame never showed the clamped position: the glide starts
  // from where the content was on screen, not from the clamp.
  const shownTopRef = useRef<number | null>(null);

  /** Stops the glide; returns how far below its layout the content shows. */
  const cancel = useCallback(() => {
    const animations = glideRef.current;
    glideRef.current = null;
    if (!animations) return 0;
    // The offset as this frame presents it. On a slow frame the animation is
    // behind the clock, and an offset worked out from the clock would move
    // the content when it is folded into scrollTop.
    const transform = layerRef.current
      ? getComputedStyle(layerRef.current).transform
      : 'none';
    for (const animation of animations) animation.cancel();
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
  }, [layerRef]);

  /** Moves the reader to the bottom; `smooth` glides there when it grew. */
  const follow = useCallback(
    (smooth: boolean) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const before = shownTopRef.current ?? scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      const moved = scroller.scrollTop - before;
      const layer = layerRef.current;
      if (!smooth || !layer || typeof layer.animate !== 'function') {
        shownTopRef.current = scroller.scrollTop;
        return;
      }
      // Nothing grew: a running glide carries on.
      if (moved < 0.5) return;
      shownTopRef.current = scroller.scrollTop;
      const viewport = scroller.clientHeight;
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      // What shows stays put: the rest of a running glide plus the move. At
      // most a viewport, since rows further up may not be mounted.
      const from = Math.min(cancel() + moved, viewport);
      const tracks: [HTMLElement, GlideTrack][] = [
        [layer, { offsets: [from, 0], easing: FOLLOW_GLIDE_EASING }],
      ];
      const rows =
        stickyScopeRef.current?.querySelectorAll<HTMLElement>(stickySelector) ??
        [];
      for (const row of rows) {
        const stuckAt =
          top + (Number.parseFloat(getComputedStyle(row).top) || 0);
        if (Math.abs(row.getBoundingClientRect().top - stuckAt) < 0.5) {
          const flow = row.parentElement ?? layer;
          const depth = stuckAt - flow.getBoundingClientRect().top;
          tracks.push([row, stickyTrack(from, depth)]);
        }
      }
      const startedAt = performance.now();
      const animations = tracks.map(([element, { offsets, easing }]) => {
        const animation = element.animate(
          offsets.map((offset) => ({ transform: `translateY(${offset}px)` })),
          { duration: FOLLOW_GLIDE_MS, easing, fill: 'backwards' },
        );
        // Start now, not once the compositor picks it up a frame later; the
        // first keyframe holds until then.
        animation.startTime = startedAt;
        return animation;
      });
      glideRef.current = animations;
      animations[0].onfinish = () => {
        if (glideRef.current === animations) glideRef.current = null;
      };
    },
    [cancel, layerRef, scrollerRef, stickyScopeRef, stickySelector],
  );

  /**
   * Ends a running glide where the content shows, folding the rest into
   * scrollTop so native scrolling takes over without a jump. Returns the new
   * scrollTop, or null if nothing was gliding.
   */
  const settle = useCallback(() => {
    const scroller = scrollerRef.current;
    const offset = cancel();
    if (!scroller || offset < 0.5) return null;
    scroller.scrollTop -= offset;
    shownTopRef.current = scroller.scrollTop;
    return scroller.scrollTop;
  }, [cancel, scrollerRef]);

  /** scrollTop moved by other means (a scroll event, a row absorbing its size). */
  const sync = useCallback((top: number) => {
    shownTopRef.current = top;
  }, []);

  useEffect(() => () => void cancel(), [cancel]);

  return useMemo(() => ({ follow, settle, sync }), [follow, settle, sync]);
}
