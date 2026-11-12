import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useReducedMotionConfig } from 'motion/react';
import { cn } from '@/lib/utils';
import {
  IDENTITY,
  TAP_MAX_DISTANCE,
  doubleTapTransform,
  dragTransform,
  isZoomed,
  pinchTransform,
  settleTransform,
  type Size,
  type ZoomTransform,
} from './zoom-pan';

/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 30;
/** A horizontal swipe this long at 1× turns the page. */
const SWIPE_MIN_DISTANCE = 50;
/** A pull down this long at 1× closes the viewer. */
const PULL_CLOSE_DISTANCE = 120;
const SETTLE_TRANSITION = 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)';

interface Point {
  x: number;
  y: number;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'press'; start: Point }
  | { kind: 'pan'; start: Point; from: ZoomTransform }
  | { kind: 'pull'; start: Point; dy: number }
  | { kind: 'swipe'; start: Point }
  | {
      kind: 'pinch';
      from: ZoomTransform;
      focal: Point;
      distance: number;
      last: Point;
    };

/**
 * Content a finger can look at closely (cindy's ImageLightbox): two fingers
 * zoom about their midpoint and move it, one finger moves the zoomed content
 * within its edges (softly past them, springing back), a double tap zooms in
 * on that point or back out, and a pinch past 1× or 4× springs back on
 * release. At 1× a sideways swipe turns the page and a pull down closes.
 * Touch and pen only: a mouse keeps what it had (clicks, the arrow keys).
 * The transform is written straight to the content, not through React, so
 * a gesture renders nothing.
 */
export function ZoomPanSurface({
  children,
  className,
  contentClassName,
  resetKey,
  onSwipe,
  onPull,
  onPullClose,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** A new value (the next image) starts again at 1×. */
  resetKey?: unknown;
  /** A swipe at 1×: 1 for the next page, -1 for the previous one. */
  onSwipe?: (direction: 1 | -1) => void;
  /** How far a pull down at 1× has gone (0 when it is let go). */
  onPull?: (distance: number) => void;
  /** A pull down far enough to close. */
  onPullClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const transform = useRef<ZoomTransform>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ kind: 'none' });
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  // The click a gesture ends with must not reach what is under it (the
  // backdrop closes the viewer on a click).
  const swallowClick = useRef(false);
  // The app's motion setting (MotionProvider), read when a gesture settles.
  const reduceMotion = useRef(false);
  reduceMotion.current = useReducedMotionConfig() ?? false;
  // Measured once a gesture starts: a move must not force a layout.
  const frame = useRef<{
    rect: DOMRect;
    container: Size;
    content: Size;
  } | null>(null);

  const apply = (next: ZoomTransform, settle: boolean, pull = 0) => {
    transform.current = next;
    const content = contentRef.current;
    if (!content) return;
    content.style.transition =
      settle && !reduceMotion.current ? SETTLE_TRANSITION : 'none';
    content.style.transform = `translate3d(${next.x}px, ${next.y + pull}px, 0) scale(${next.scale})`;
    content.dataset.zoomed = isZoomed(next.scale) ? 'true' : 'false';
  };

  useEffect(() => {
    apply(IDENTITY, false);
    gesture.current = { kind: 'none' };
    lastTap.current = null;
  }, [resetKey]);

  const measure = () => {
    const container = containerRef.current!;
    const content = contentRef.current;
    frame.current = {
      rect: container.getBoundingClientRect(),
      container: {
        width: container.clientWidth,
        height: container.clientHeight,
      },
      // The layout box: a transform does not change it.
      content: {
        width: content?.offsetWidth ?? 0,
        height: content?.offsetHeight ?? 0,
      },
    };
    return frame.current;
  };
  const sizes = () => frame.current ?? measure();

  /** A pointer's position from the container's centre. */
  const local = (event: { clientX: number; clientY: number }): Point => {
    const { rect } = sizes();
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  };

  const twoFingers = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      focal: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  /** One finger down (the first, or the one left of a pinch). */
  const pressWith = (point: Point) => {
    gesture.current = isZoomed(transform.current.scale)
      ? { kind: 'pan', start: point, from: transform.current }
      : { kind: 'press', start: point };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // No explicit capture: a touch is held by what it pressed already, and
    // capturing here would retarget the click (the image's own click handler
    // keeps a tap on it from closing the viewer).
    if (event.pointerType === 'mouse') return;
    if (pointers.current.size === 0) measure();
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) {
      swallowClick.current = false;
      pressWith(point);
      return;
    }
    if (pointers.current.size === 2) {
      const { focal, distance } = twoFingers();
      if (gesture.current.kind === 'pull') onPull?.(0);
      gesture.current = {
        kind: 'pinch',
        from: transform.current,
        focal,
        distance,
        last: focal,
      };
      swallowClick.current = true;
      apply(transform.current, false);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (current.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const { focal, distance } = twoFingers();
      current.last = focal;
      apply(
        pinchTransform(
          current.from,
          current.focal,
          current.distance,
          focal,
          distance,
        ),
        false,
      );
      return;
    }
    if (current.kind === 'none') return;
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    if (current.kind === 'press') {
      if (Math.hypot(dx, dy) < TAP_MAX_DISTANCE) return;
      swallowClick.current = true;
      gesture.current =
        dy > 0 && Math.abs(dy) > Math.abs(dx)
          ? { kind: 'pull', start: current.start, dy }
          : { kind: 'swipe', start: current.start };
    }
    const next = gesture.current;
    if (next.kind === 'pan') {
      if (Math.hypot(dx, dy) >= TAP_MAX_DISTANCE) swallowClick.current = true;
      const { container, content } = sizes();
      apply(dragTransform(next.from, dx, dy, container, content), false);
    } else if (next.kind === 'pull') {
      next.dy = Math.max(0, dy);
      apply(transform.current, false, next.dy);
      onPull?.(next.dy);
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointers.current.get(event.pointerId);
    if (!point) return;
    pointers.current.delete(event.pointerId);
    const current = gesture.current;
    const { container, content } = sizes();

    if (current.kind === 'pinch') {
      if (pointers.current.size === 1) {
        // One finger stays: it carries on as a pan from here, without a jump.
        const [rest] = [...pointers.current.values()];
        gesture.current = {
          kind: 'pan',
          start: rest,
          from: transform.current,
        };
        return;
      }
      gesture.current = { kind: 'none' };
      apply(
        settleTransform(transform.current, current.last, container, content),
        true,
      );
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = { kind: 'none' };
    if (event.type === 'pointercancel') {
      apply(
        settleTransform(transform.current, point, container, content),
        true,
      );
      onPull?.(0);
      return;
    }

    switch (current.kind) {
      case 'pan':
        apply(
          settleTransform(transform.current, point, container, content),
          true,
        );
        if (swallowClick.current) return;
        break;
      case 'pull':
        if (current.dy >= PULL_CLOSE_DISTANCE && onPullClose) {
          onPullClose();
        } else {
          apply(transform.current, true);
          onPull?.(0);
        }
        return;
      case 'swipe': {
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        if (
          Math.abs(dx) > SWIPE_MIN_DISTANCE &&
          Math.abs(dy) < SWIPE_MIN_DISTANCE
        ) {
          onSwipe?.(dx < 0 ? 1 : -1);
        }
        return;
      }
      case 'none':
        return;
    }

    // A tap: the second of two zooms.
    const now = event.timeStamp;
    const previous = lastTap.current;
    if (
      previous &&
      now - previous.at < DOUBLE_TAP_MS &&
      Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <
        DOUBLE_TAP_DISTANCE
    ) {
      lastTap.current = null;
      swallowClick.current = true;
      apply(
        doubleTapTransform(transform.current, point, container, content),
        true,
      );
      return;
    }
    lastTap.current = { at: now, point };
  };

  return (
    <div
      ref={containerRef}
      data-hc-zoom-surface=""
      className={cn('relative touch-none overflow-hidden', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        ref={contentRef}
        data-hc-zoom-content=""
        data-zoomed="false"
        className={cn('will-change-transform', contentClassName)}
      >
        {children}
      </div>
    </div>
  );
}
