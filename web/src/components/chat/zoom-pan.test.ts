import { describe, expect, it } from 'vitest';

import {
  IDENTITY,
  ZOOM_DOUBLE_TAP_SCALE,
  ZOOM_MAX_SCALE,
  doubleTapTransform,
  dragTransform,
  pinchTransform,
  rubberBandScale,
  settleTransform,
} from './zoom-pan';

const container = { width: 400, height: 800 };
const content = { width: 400, height: 300 };

/** Where a content point shows on screen under `t`. */
const screen = (t: typeof IDENTITY, x: number, y: number) => ({
  x: x * t.scale + t.x,
  y: y * t.scale + t.y,
});

describe('zoom-pan', () => {
  it('keeps the point under the fingers there as they spread and move', () => {
    const focal = { x: 100, y: -50 };
    const t = pinchTransform(IDENTITY, focal, 100, { x: 120, y: -40 }, 200);
    expect(t.scale).toBe(2);
    // The content point first under the midpoint is under it still.
    expect(screen(t, 100, -50)).toEqual({ x: 120, y: -40 });
  });

  it('resists a pinch past the largest scale and springs back to it', () => {
    const t = pinchTransform(
      IDENTITY,
      { x: 0, y: 0 },
      100,
      { x: 0, y: 0 },
      800,
    );
    expect(t.scale).toBeGreaterThan(ZOOM_MAX_SCALE);
    expect(t.scale).toBeLessThan(8);
    expect(settleTransform(t, { x: 0, y: 0 }, container, content).scale).toBe(
      ZOOM_MAX_SCALE,
    );
    expect(rubberBandScale(0.5)).toBeGreaterThan(0.5);
  });

  it('springs back to 1× centred from a pinch below it', () => {
    const t = pinchTransform(
      IDENTITY,
      { x: 50, y: 50 },
      200,
      { x: 80, y: 90 },
      100,
    );
    expect(t.scale).toBeLessThan(1);
    expect(settleTransform(t, { x: 80, y: 90 }, container, content)).toEqual(
      IDENTITY,
    );
  });

  it('pans the zoomed content softly past an edge, and back within it on release', () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    // At 2× the 400px-wide content is 800 wide: 200px of room each way.
    const dragged = dragTransform(zoomed, 500, 0, container, content);
    expect(dragged.x).toBeGreaterThan(200);
    expect(dragged.x).toBeLessThan(500);
    expect(settleTransform(dragged, { x: 0, y: 0 }, container, content).x).toBe(
      200,
    );
    // 300px tall at 2× is 600, inside 800: it does not move vertically.
    expect(
      settleTransform(
        dragTransform(zoomed, 0, 100, container, content),
        { x: 0, y: 0 },
        container,
        content,
      ).y,
    ).toBe(0);
  });

  it('zooms in on a double-tapped point, and back out', () => {
    const point = { x: 80, y: 20 };
    const zoomed = doubleTapTransform(IDENTITY, point, container, content);
    expect(zoomed.scale).toBe(ZOOM_DOUBLE_TAP_SCALE);
    expect(screen(zoomed, 80, 20).x).toBeCloseTo(80);
    expect(doubleTapTransform(zoomed, point, container, content)).toEqual(
      IDENTITY,
    );
  });
});
