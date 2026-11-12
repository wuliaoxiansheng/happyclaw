import type { Page } from '@playwright/test';

/**
 * Fingers on the screen, for gestures `locator.tap()` cannot make: a hold, a
 * drag, two fingers.
 *
 * Chromium takes them through CDP, so the browser makes every event itself.
 * WebKit has no CDP and Playwright's WebKit touchscreen only taps, so there
 * the page gets what iOS Safari sends for the same fingers: per finger a
 * pointer event, then the touch event, both to the element first touched; a
 * finger that moves past the slop on an element the browser may pan
 * (`touch-action` not `none`) gets `pointercancel` while its touch events
 * carry on; a finger lifted where it went down ends with a click, unless the
 * page called `preventDefault()` on its touch events. Synthetic events do not
 * scroll anything.
 */
export interface Touchscreen {
  down(points: TouchPoint[]): Promise<void>;
  move(points: TouchPoint[]): Promise<void>;
  /** Lifts every finger. */
  up(): Promise<void>;
}

export type TouchPoint = { x: number; y: number };

type Phase = 'down' | 'move' | 'up';

const CDP_TYPE = {
  down: 'touchStart',
  move: 'touchMove',
  up: 'touchEnd',
} as const;

export async function touchscreen(page: Page): Promise<Touchscreen> {
  const engine = page.context().browser()?.browserType().name();
  let send: (phase: Phase, points: TouchPoint[]) => Promise<unknown>;
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    send = (phase, points) =>
      cdp.send('Input.dispatchTouchEvent', {
        type: CDP_TYPE[phase],
        touchPoints: points.map((point, id) => ({
          x: Math.round(point.x),
          y: Math.round(point.y),
          id,
        })),
      });
  } else {
    send = (phase, points) => page.evaluate(synthesize, { phase, points });
  }
  return {
    down: async (points) => void (await send('down', points)),
    move: async (points) => void (await send('move', points)),
    up: async () => void (await send('up', [])),
  };
}

/** Runs in the page: one step of the fingers, as iOS Safari reports it. */
function synthesize({ phase, points }: { phase: Phase; points: TouchPoint[] }) {
  /** Past this (px) a finger is no longer a tap, and the browser may pan. */
  const SLOP = 10;
  type FingerState = {
    id: number;
    /** The first finger of the gesture. */
    primary: boolean;
    target: Element;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
    /** Whether the browser may pan what the finger went down on. */
    pannable: boolean;
    /** The browser took the finger for a pan: no more pointer events. */
    panned: boolean;
    prevented: boolean;
  };
  const store = window as unknown as { __e2eFingers?: FingerState[] };
  const fingers = (store.__e2eFingers ??= []);

  const pans = (target: Element) => {
    for (let el: Element | null = target; el; el = el.parentElement) {
      if (getComputedStyle(el).touchAction === 'none') return false;
    }
    return true;
  };
  // WebKit's TouchEvent and Touch have no constructors, only these.
  const doc = document as Document & {
    createTouch: (...args: unknown[]) => Touch;
    createTouchList: (...touches: Touch[]) => TouchList;
  };
  const toList = (list: FingerState[]) =>
    doc.createTouchList(
      ...list.map((finger) =>
        doc.createTouch(
          window,
          finger.target,
          finger.id,
          finger.x + window.scrollX,
          finger.y + window.scrollY,
          finger.x,
          finger.y,
        ),
      ),
    );
  const pointer = (type: string, finger: FingerState) =>
    finger.target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: type !== 'pointercancel',
        composed: true,
        pointerId: 100 + finger.id,
        pointerType: 'touch',
        isPrimary: finger.primary,
        clientX: finger.x,
        clientY: finger.y,
        screenX: finger.x,
        screenY: finger.y,
        button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
        width: 1,
        height: 1,
        pressure: type === 'pointerup' ? 0 : 0.5,
      }),
    );
  const touch = (type: string, changed: FingerState[], rest: FingerState[]) => {
    const event = document.createEvent('TouchEvent');
    event.initEvent(type, true, type !== 'touchcancel');
    const target = changed[0].target;
    Object.defineProperties(event, {
      touches: { value: toList(rest) },
      targetTouches: {
        value: toList(rest.filter((finger) => finger.target === target)),
      },
      changedTouches: { value: toList(changed) },
    });
    target.dispatchEvent(event);
    if (event.defaultPrevented) {
      for (const finger of changed) finger.prevented = true;
    }
  };

  if (phase === 'down') {
    const added = points.slice(fingers.length).map((point, index) => {
      const target =
        document.elementFromPoint(point.x, point.y) ?? document.body;
      return {
        id: fingers.length + index,
        primary: fingers.length + index === 0,
        target,
        x: point.x,
        y: point.y,
        startX: point.x,
        startY: point.y,
        moved: false,
        pannable: pans(target),
        panned: false,
        prevented: false,
      };
    });
    for (const finger of added) {
      fingers.push(finger);
      // iOS sends no click for a touch whose pointerdown was cancelled.
      if (!pointer('pointerdown', finger)) finger.prevented = true;
    }
    touch('touchstart', added, fingers);
    return;
  }
  if (phase === 'move') {
    const moving = fingers.slice(0, points.length);
    for (const [index, finger] of moving.entries()) {
      const point = points[index];
      finger.x = point.x;
      finger.y = point.y;
      if (
        Math.hypot(finger.x - finger.startX, finger.y - finger.startY) > SLOP
      ) {
        finger.moved = true;
        if (finger.pannable && !finger.panned) {
          finger.panned = true;
          pointer('pointercancel', finger);
        }
      }
      if (!finger.panned) pointer('pointermove', finger);
    }
    if (moving.length) touch('touchmove', moving, fingers);
    return;
  }
  const lifted = fingers.splice(0);
  if (!lifted.length) return;
  for (const finger of lifted) {
    if (!finger.panned) pointer('pointerup', finger);
  }
  touch('touchend', lifted, []);
  // A single tap ends with the click mouse code listens for.
  const [only] = lifted;
  if (lifted.length === 1 && !only.moved && !only.prevented) {
    only.target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        detail: 1,
        clientX: only.x,
        clientY: only.y,
        screenX: only.x,
        screenY: only.y,
      }),
    );
  }
}
