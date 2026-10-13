import { useEffect, useRef, useState } from 'react';

/**
 * Follow `value`, but let a change settle for `delayMs` first, so a line that
 * changes with every step reads as a line and not as a flicker. Values that
 * come and go within the delay are skipped: what shows is the latest when the
 * delay is up. A change never waits longer than the delay however often the
 * value moves meanwhile (a plain debounce would never show it).
 *
 * `key` stands for everything about `value` that is shown: the same key means
 * the same line, so a new object for it is not a change.
 */
export function useSteadyValue<T>(value: T, key: string, delayMs: number): T {
  const [shown, setShown] = useState({ key, value });
  const latest = useRef({ key, value });
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    latest.current = { key, value };
  });

  useEffect(() => {
    if (key === shown.key || timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setShown(latest.current);
    }, delayMs);
  }, [key, shown.key, delayMs]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    },
    [],
  );

  return shown.value;
}
