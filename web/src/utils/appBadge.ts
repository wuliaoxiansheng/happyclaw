/**
 * The unread count on the installed app's icon, through the Badging API:
 * Chromium desktop and Android apps, and iOS 16.4+ Home Screen apps once
 * notifications are allowed. A plain browser tab has no icon to badge, and
 * where the API is missing this does nothing; the page title still carries
 * the count.
 *
 * The count is the page title's: new replies this window received while it
 * was open, in another conversation or while hidden. It lives in memory, not
 * on the server, so a reopened app starts from zero.
 */
interface BadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

function currentNavigator(): BadgeNavigator | undefined {
  return typeof navigator === 'undefined'
    ? undefined
    : (navigator as BadgeNavigator);
}

export function syncAppBadge(
  count: number,
  nav: BadgeNavigator | undefined = currentNavigator(),
): void {
  if (!nav?.setAppBadge || !nav.clearAppBadge) return;
  const unread = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  // The browser may refuse (not installed, notifications not allowed);
  // the badge is a convenience, so a refusal is not an error.
  const settled =
    unread > 0
      ? nav.setAppBadge.call(nav, unread)
      : nav.clearAppBadge.call(nav);
  void settled?.catch(() => {});
}
