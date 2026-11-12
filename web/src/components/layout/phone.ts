import { useMediaQuery } from '../../hooks/useMediaQuery';

/**
 * A phone: below the desktop layout and driven by touch, the same query as
 * the `phone:` CSS variant. Narrow desktop windows keep the tablet layout
 * (bottom tab bar, workspace → session list → chat).
 */
const PHONE_MEDIA_QUERY = '(max-width: 1023px) and (pointer: coarse)';

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_MEDIA_QUERY);
}
