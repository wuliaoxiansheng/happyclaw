/**
 * Reject with `${label} timed out after ${timeoutMs}ms` if `operation` has not
 * settled in time. The underlying work keeps running; `onTimeout` lets the
 * caller abort it.
 */
export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      try {
        onTimeout?.();
      } finally {
        reject(error);
      }
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
