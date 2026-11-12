/**
 * The arithmetic of a pinch-zoomable view (cindy imageLightboxModel). The
 * content sits centred in its container, scaled about its centre and moved
 * by (x, y); points are measured from the container's centre, so a content
 * point `c` shows at `c * scale + translate`.
 */

export const ZOOM_MIN_SCALE = 1;
export const ZOOM_MAX_SCALE = 4;
/** What a double tap zooms to (between the 2× and 3× of IM apps). */
export const ZOOM_DOUBLE_TAP_SCALE = 2.5;
/** Scales this close to 1 are 1: float noise must not lock paging. */
export const ZOOM_EPSILON = 0.01;
/** A press that moves less than this is a tap. */
export const TAP_MAX_DISTANCE = 12;
/** UIScrollView's rubber band. */
const RUBBER_BAND_COEFFICIENT = 0.55;

export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

/** Past an edge by `overshoot`, the view moves less the further it goes. */
export function rubberBand(overshoot: number, dimension: number): number {
  if (overshoot <= 0 || dimension <= 0) return 0;
  return (
    (1 - 1 / ((overshoot * RUBBER_BAND_COEFFICIENT) / dimension + 1)) *
    dimension
  );
}

/** A pinch past 1× or the largest scale resists, rather than stopping dead. */
export function rubberBandScale(raw: number): number {
  if (raw < ZOOM_MIN_SCALE) {
    return (
      ZOOM_MIN_SCALE - rubberBand(ZOOM_MIN_SCALE - raw, ZOOM_MIN_SCALE / 2)
    );
  }
  if (raw > ZOOM_MAX_SCALE) {
    return (
      ZOOM_MAX_SCALE + rubberBand(raw - ZOOM_MAX_SCALE, ZOOM_MAX_SCALE / 2)
    );
  }
  return raw;
}

export function isZoomed(scale: number): boolean {
  return scale > ZOOM_MIN_SCALE + ZOOM_EPSILON;
}

/** How far the content may move each way at `scale` before an edge shows. */
export function panLimit(
  container: number,
  content: number,
  scale: number,
): number {
  return Math.max(0, (content * scale - container) / 2);
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** Within the edges, softly past them while a finger holds it. */
function soft(value: number, limit: number, dimension: number): number {
  if (value > limit) return limit + rubberBand(value - limit, dimension);
  if (value < -limit) return -limit - rubberBand(-limit - value, dimension);
  return value;
}

/** A one-finger drag of the zoomed content from `start` by (dx, dy). */
export function dragTransform(
  start: ZoomTransform,
  dx: number,
  dy: number,
  container: Size,
  content: Size,
): ZoomTransform {
  const { scale } = start;
  return {
    scale,
    x: soft(
      start.x + dx,
      panLimit(container.width, content.width, scale),
      container.width,
    ),
    y: soft(
      start.y + dy,
      panLimit(container.height, content.height, scale),
      container.height,
    ),
  };
}

/**
 * Two fingers: the content point that was under their midpoint when the pinch
 * began stays under it, wherever the midpoint goes and however far apart the
 * fingers move.
 */
export function pinchTransform(
  start: ZoomTransform,
  startFocal: { x: number; y: number },
  startDistance: number,
  focal: { x: number; y: number },
  distance: number,
): ZoomTransform {
  const scale = rubberBandScale(
    start.scale * (startDistance > 0 ? distance / startDistance : 1),
  );
  const cx = (startFocal.x - start.x) / start.scale;
  const cy = (startFocal.y - start.y) / start.scale;
  return { scale, x: focal.x - cx * scale, y: focal.y - cy * scale };
}

/**
 * Where the content comes to rest once let go: the scale back within its
 * range about `focal` (the point last under the fingers), then within the
 * edges. At 1× it is centred.
 */
export function settleTransform(
  current: ZoomTransform,
  focal: { x: number; y: number },
  container: Size,
  content: Size,
): ZoomTransform {
  const scale = Math.min(
    ZOOM_MAX_SCALE,
    Math.max(ZOOM_MIN_SCALE, current.scale),
  );
  if (!isZoomed(scale)) return IDENTITY;
  const ratio = scale / current.scale;
  const x = focal.x - (focal.x - current.x) * ratio;
  const y = focal.y - (focal.y - current.y) * ratio;
  return {
    scale,
    x: clamp(x, panLimit(container.width, content.width, scale)),
    y: clamp(y, panLimit(container.height, content.height, scale)),
  };
}

/** A double tap zooms in on the tapped point, or back out to 1×. */
export function doubleTapTransform(
  current: ZoomTransform,
  point: { x: number; y: number },
  container: Size,
  content: Size,
): ZoomTransform {
  if (isZoomed(current.scale)) return IDENTITY;
  return settleTransform(
    {
      scale: ZOOM_DOUBLE_TAP_SCALE,
      x:
        point.x -
        ((point.x - current.x) / current.scale) * ZOOM_DOUBLE_TAP_SCALE,
      y:
        point.y -
        ((point.y - current.y) / current.scale) * ZOOM_DOUBLE_TAP_SCALE,
    },
    point,
    container,
    content,
  );
}
