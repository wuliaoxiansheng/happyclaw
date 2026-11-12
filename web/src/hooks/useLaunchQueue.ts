import { useEffect } from 'react';
import { stripBasePath, APP_BASE } from '../utils/url';

export interface LaunchParams {
  targetURL?: string;
}

export interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface LaunchRouter {
  navigate(to: string): unknown;
}

/**
 * The in-app path for a launch target, or null when it is not ours to route:
 * another origin, outside the app base, or the page that is already open.
 */
export function launchTargetPath(
  targetURL: string | undefined,
  current: Pick<Location, 'href' | 'origin'>,
): string | null {
  if (!targetURL) return null;
  let url: URL;
  try {
    url = new URL(targetURL, current.href);
  } catch {
    return null;
  }
  if (url.origin !== current.origin || url.href === current.href) return null;
  const base = APP_BASE.slice(0, -1);
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
    return null;
  }
  return `${stripBasePath(url.pathname)}${url.search}${url.hash}`;
}

/**
 * With `launch_handler.client_mode: focus-existing`, opening a shortcut or a
 * link while the app is running focuses the open window and hands the target
 * to the launch queue. Route it in place: a full navigation would drop the
 * live stream connections and the scroll position. Browsers without the
 * Launch Handler API open or navigate a window themselves.
 */
export function useLaunchQueue(router: LaunchRouter): void {
  useEffect(() => {
    const queue = (window as Window & { launchQueue?: LaunchQueue })
      .launchQueue;
    // A consumer cannot be removed, and setting it again only replaces it,
    // so there is no cleanup.
    queue?.setConsumer((params) => {
      const path = launchTargetPath(params.targetURL, window.location);
      if (path) void router.navigate(path);
    });
  }, [router]);
}
