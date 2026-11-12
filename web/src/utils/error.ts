import type { ApiError } from '../api/client';

/** The JSON body of a failed API request (ApiError.body), if it had one. */
export function apiErrorBody(
  err: unknown,
): Record<string, unknown> | undefined {
  return typeof err === 'object' && err !== null && 'body' in err
    ? (err as ApiError).body
    : undefined;
}

/** Extract a human-readable message from an unknown catch value. */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err)
    return (err as ApiError).message;
  return String(err);
}
