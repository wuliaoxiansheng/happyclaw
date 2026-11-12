/**
 * Detects that this Feishu/Lark app's long connection is held elsewhere.
 *
 * The Lark SDK has no "replaced by another client" event. Two signals are
 * available instead:
 *  - endpoint discovery is refused with `exceed_conn_limit` (1000040350); the
 *    SDK then gives up and reports it through `onError`. Only this is told to
 *    the user as a certain conflict;
 *  - the client keeps entering its reconnect loop (two or more times) and
 *    does not become ready within about eight seconds. An outage or platform
 *    trouble looks the same, so the text names both causes.
 *
 * Each incident is reported once (a later refusal upgrades a heuristic
 * report to the certain text); the first ready connection after it reports
 * `null`. The monitor only observes: reconnect pacing stays with the
 * connection's own health check, so a conflict never speeds up rebuilds.
 */
import type { FeishuBrand } from './feishu-domain.js';

export type FeishuTransportIssue = { kind: 'conflict'; message: string };

const READY_TIMEOUT_MS = 8_000;
const RECONNECT_THRESHOLD = 2;

/** How user-facing text names the app: 飞书应用 / Lark 应用. */
export function feishuAppLabel(brand: FeishuBrand): string {
  return brand === 'lark' ? 'Lark 应用' : '飞书应用';
}

/** Account status text when Feishu refused the connection as over its limit. */
export function feishuConnectionConflictMessage(brand: FeishuBrand): string {
  return `该${feishuAppLabel(brand)}的长连接已被其他程序占用（同一 App 同时只应连接一处），消息可能被对方接走。请停用另一处连接，或为 HappyClaw 单独创建应用。`;
}

/** Account status text when the connection keeps dropping without a cause. */
export function feishuConnectionUnstableMessage(brand: FeishuBrand): string {
  return `${brand === 'lark' ? 'Lark ' : '飞书'}长连接反复断开：可能是同一应用在别处也建立了长连接，也可能是网络或平台异常。`;
}

/** Feishu refused the connection because the app is at its connection limit. */
export function isFeishuConnectionConflictSignal(error: unknown): boolean {
  const text = (
    error instanceof Error ? error.message : String(error ?? '')
  ).toLowerCase();
  return text.includes('1000040350') || text.includes('exceed_conn_limit');
}

export interface FeishuConflictMonitor {
  /** A new long-connection client is starting; opens a ready window. */
  starting(): void;
  /** The SDK entered its reconnect loop after a disconnect. */
  reconnecting(): void;
  /** The connection is up (`onReady` / `onReconnected`). */
  ready(): void;
  /** The SDK gave up on the connection (`onError`). */
  failed(error: unknown): void;
  /** The open incident, if any (reported or not yet delivered). */
  current(): FeishuTransportIssue | null;
  /** The connection stopped: drop timers and state, report nothing. */
  stop(): void;
}

export function createFeishuConflictMonitor(options: {
  brand: FeishuBrand;
  report: (issue: FeishuTransportIssue | null) => void;
  /**
   * Reconnect attempts the SDK made without a ready callback in between
   * (`getConnectionStatus().reconnectAttempts`). The SDK fires
   * `onReconnecting` only after a first successful connect, so attempts
   * before that are only visible here.
   */
  reconnectAttempts?: () => number;
}): FeishuConflictMonitor {
  const certain: FeishuTransportIssue = {
    kind: 'conflict',
    message: feishuConnectionConflictMessage(options.brand),
  };
  const suspected: FeishuTransportIssue = {
    kind: 'conflict',
    message: feishuConnectionUnstableMessage(options.brand),
  };
  let reported: FeishuTransportIssue | null = null;
  let reconnects = 0;
  let timer: NodeJS.Timeout | null = null;

  const closeWindow = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    reconnects = 0;
  };
  const conflict = (issue: FeishuTransportIssue): void => {
    closeWindow();
    // Never repeat an incident, never downgrade a certain one.
    if (reported === issue || reported === certain) return;
    reported = issue;
    options.report(issue);
  };
  const openWindow = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      let attempts = reconnects;
      try {
        attempts = Math.max(attempts, options.reconnectAttempts?.() ?? 0);
      } catch {
        // A changed SDK status shape only loses the extra signal.
      }
      reconnects = 0;
      if (attempts >= RECONNECT_THRESHOLD) conflict(suspected);
    }, READY_TIMEOUT_MS);
    timer.unref?.();
  };

  return {
    starting() {
      closeWindow();
      openWindow();
    },
    reconnecting() {
      reconnects += 1;
      openWindow();
    },
    ready() {
      closeWindow();
      if (!reported) return;
      reported = null;
      options.report(null);
    },
    failed(error) {
      if (isFeishuConnectionConflictSignal(error)) conflict(certain);
    },
    current() {
      return reported;
    },
    stop() {
      closeWindow();
      reported = null;
    },
  };
}
