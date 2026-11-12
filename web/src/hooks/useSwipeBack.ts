import { useRef, useCallback, useEffect } from 'react';
import { useIsPhone } from '../components/layout/phone';
import { hasAppEntryBefore } from '../lib/chat-navigation';
import { isIOSDevice } from '../utils/url';
import { useMediaQuery } from './useMediaQuery';
import { useStableCallback } from './useStableCallback';

interface SwipeBackOptions {
  edgeWidth?: number;
  threshold?: number;
  /**
   * What the page goes back to, laid out under the container (hidden while
   * it is covered): shown while the finger drags the container aside.
   */
  underlayRef?: React.RefObject<HTMLElement | null>;
  /** Off while the container is not mounted; turning it on attaches. */
  enabled?: boolean;
}

const SLIDE = 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)';
/** After a swipe out, how long the container may stay aside for the route to change. */
const LEAVE_FALLBACK_MS = 400;

/**
 * Drag from the left edge to go back, on phones.
 *
 * Safari in a browser tab has its own edge swipe, which goes back through
 * the history; it takes the touch over (the page sees touchcancel), so this
 * one stands aside whenever there is an entry to go back to and only covers
 * a page opened directly. A home-screen app has no system gesture, and
 * Android's back gesture claims the screen edge before the page does, so
 * there it always runs.
 */
export function useSwipeBack(
  containerRef: React.RefObject<HTMLElement | null>,
  onBack: () => void,
  options: SwipeBackOptions = {},
) {
  const {
    edgeWidth = 20,
    threshold = 0.4,
    underlayRef,
    enabled = true,
  } = options;
  const isPhone = useIsPhone();
  const isStandalone = useMediaQuery('(display-mode: standalone)');
  // A stable callback: a parent re-rendering mid-swipe (a streaming reply)
  // must not re-register the listeners and drop the gesture.
  const back = useStableCallback(onBack);
  const touchRef = useRef({
    startX: 0,
    startY: 0,
    active: false,
    currentX: 0,
    isHorizontal: null as boolean | null,
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const setUnderlayShown = useCallback(
    (shown: boolean) => {
      const underlay = underlayRef?.current;
      if (underlay) underlay.style.visibility = shown ? 'visible' : '';
    },
    [underlayRef],
  );

  const resetTransformNow = useCallback(() => {
    setUnderlayShown(false);
    const el = containerRef.current;
    if (!el) return;
    el.style.transform = '';
    el.style.transition = '';
    el.style.willChange = '';
  }, [containerRef, setUnderlayShown]);

  const snapBack = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.transition = SLIDE;
    el.style.transform = 'translateX(0)';
    clearTimer();
    timeoutRef.current = setTimeout(() => {
      resetTransformNow();
    }, 250);
  }, [containerRef, clearTimer, resetTransformNow]);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-swipe-back-ignore="true"]')) return;
      if (!isStandalone && isIOSDevice() && hasAppEntryBefore()) return;

      const touch = e.touches[0];
      if (touch.clientX < edgeWidth) {
        touchRef.current = {
          startX: touch.clientX,
          startY: touch.clientY,
          active: true,
          currentX: 0,
          isHorizontal: null,
        };
      }
    },
    [edgeWidth, isStandalone],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!touchRef.current.active) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchRef.current.startX;
      const deltaY = touch.clientY - touchRef.current.startY;

      // Direction detection after minimal movement.
      if (touchRef.current.isHorizontal === null) {
        if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
        touchRef.current.isHorizontal =
          Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
        if (!touchRef.current.isHorizontal) {
          touchRef.current.active = false;
          resetTransformNow();
          return;
        }
        clearTimer();
        setUnderlayShown(true);
      }

      if (deltaX > 0 && containerRef.current) {
        touchRef.current.currentX = deltaX;
        containerRef.current.style.transition = 'none';
        containerRef.current.style.transform = `translateX(${deltaX}px)`;
        containerRef.current.style.willChange = 'transform';
      }
    },
    [containerRef, clearTimer, resetTransformNow, setUnderlayShown],
  );

  const handleTouchEnd = useCallback(() => {
    if (!touchRef.current.active) return;
    touchRef.current.active = false;
    const isHorizontal = touchRef.current.isHorizontal === true;
    touchRef.current.isHorizontal = null;

    const el = containerRef.current;
    if (!el) return;
    if (!isHorizontal) {
      resetTransformNow();
      return;
    }

    const swipeDistance = touchRef.current.currentX;
    const screenWidth = window.innerWidth;

    if (swipeDistance > screenWidth * threshold) {
      // Swipe out, then go back with the page still aside: the route change
      // unmounts it. Should it stay (back landed on the same page), it
      // comes back after a moment.
      el.style.transition = SLIDE;
      el.style.transform = `translateX(${screenWidth}px)`;
      clearTimer();
      timeoutRef.current = setTimeout(() => {
        back();
        timeoutRef.current = setTimeout(resetTransformNow, LEAVE_FALLBACK_MS);
      }, 250);
    } else {
      snapBack();
    }
  }, [containerRef, threshold, back, clearTimer, resetTransformNow, snapBack]);

  const handleTouchCancel = useCallback(() => {
    if (!touchRef.current.active && touchRef.current.currentX <= 0) return;
    touchRef.current.active = false;
    touchRef.current.currentX = 0;
    touchRef.current.isHorizontal = null;
    snapBack();
  }, [snapBack]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isPhone || !enabled) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('touchcancel', handleTouchCancel);

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchCancel);
      clearTimer();
      resetTransformNow();
    };
  }, [
    containerRef,
    isPhone,
    enabled,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    clearTimer,
    resetTransformNow,
  ]);
}
