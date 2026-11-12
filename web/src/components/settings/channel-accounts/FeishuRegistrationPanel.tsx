import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  QrCode,
  RefreshCw,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  useChannelAccountsStore,
  type ChannelAccount,
  type FeishuBrand,
  type FeishuRegistration,
} from '../../../stores/channel-accounts';
import { feishuBrandName, spacedLabel } from '../../../utils/channel-accounts';
import { getErrorMessage } from '../types';

/** The server polls Feishu; this only reads the server's in-memory state. */
const STATUS_POLL_MS = 2_000;

export interface FeishuRegistrationResult {
  account: ChannelAccount;
  eventConsoleUrl?: string;
}

interface FeishuRegistrationPanelProps {
  name: string;
  brand: FeishuBrand;
  /** True while a registration is being started or is waiting for a scan. */
  onActiveChange?: (active: boolean) => void;
  onSuccess: (result: FeishuRegistrationResult) => void;
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'live'; registration: FeishuRegistration }
  | { phase: 'failed'; message: string };

export function FeishuRegistrationPanel({
  name,
  brand,
  onActiveChange,
  onSuccess,
}: FeishuRegistrationPanelProps) {
  const beginFeishuRegistration = useChannelAccountsStore(
    (state) => state.beginFeishuRegistration,
  );
  const getFeishuRegistration = useChannelAccountsStore(
    (state) => state.getFeishuRegistration,
  );
  const cancelFeishuRegistration = useChannelAccountsStore(
    (state) => state.cancelFeishuRegistration,
  );
  const [state, setState] = useState<PanelState>({ phase: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const pendingIdRef = useRef<string | null>(null);
  const succeededRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const registration = state.phase === 'live' ? state.registration : null;
  const waiting =
    registration?.status === 'pending' || registration?.status === 'creating';
  const active = state.phase === 'starting' || waiting;
  pendingIdRef.current = waiting ? registration.id : null;

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Leaving the dialog mid-scan abandons the code on the server too.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const id = pendingIdRef.current;
      if (id) void cancelFeishuRegistration(id).catch(() => undefined);
    };
  }, [cancelFeishuRegistration]);

  const start = async () => {
    succeededRef.current = false;
    setState({ phase: 'starting' });
    try {
      const started = await beginFeishuRegistration({
        brand,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      // Closed while the code was being requested: nobody will scan it, so
      // free the server's slot instead of letting it poll until expiry.
      if (!mountedRef.current) {
        void cancelFeishuRegistration(started.id).catch(() => undefined);
        return;
      }
      setNow(Date.now());
      setState({ phase: 'live', registration: started });
    } catch (err) {
      setState({
        phase: 'failed',
        message: getErrorMessage(err, '无法生成二维码，请稍后重试'),
      });
    }
  };

  const refresh = useCallback(
    async (id: string) => {
      try {
        const result = await getFeishuRegistration(id);
        if (
          result.registration.status === 'success' &&
          result.account &&
          !succeededRef.current
        ) {
          succeededRef.current = true;
          onSuccessRef.current({
            account: result.account,
            eventConsoleUrl: result.registration.event_console_url,
          });
        }
        // Status reads omit the QR image; keep the one from the start.
        setState((current) =>
          current.phase === 'live' && current.registration.id === id
            ? {
                phase: 'live',
                registration: {
                  ...current.registration,
                  ...result.registration,
                },
              }
            : current,
        );
      } catch (err) {
        // Transient read errors just wait for the next tick.
        if ((err as { status?: number }).status !== 404) return;
        setState((current) =>
          current.phase === 'live' && current.registration.id === id
            ? {
                phase: 'failed',
                message: '二维码已失效（服务可能已重启），请重新生成',
              }
            : current,
        );
      }
    },
    [getFeishuRegistration],
  );

  const registrationId = registration?.id;
  useEffect(() => {
    if (!waiting || !registrationId) return;
    const timer = window.setInterval(
      () => void refresh(registrationId),
      STATUS_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [refresh, registrationId, waiting]);

  const counting = registration?.status === 'pending';
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [counting]);

  const cancel = async () => {
    if (!registration) return;
    setState({ phase: 'idle' });
    await cancelFeishuRegistration(registration.id).catch(() => undefined);
  };

  const appName = feishuBrandName(brand);
  const status = describeState(state, appName);
  const secondsLeft = registration
    ? Math.max(0, Math.ceil((Date.parse(registration.expires_at) - now) / 1000))
    : 0;

  return (
    <div className="space-y-4">
      <div
        aria-live="polite"
        className="flex items-start gap-3 rounded-lg bg-muted/50 px-4 py-3 ring-1 ring-surface-border"
      >
        {status.tone === 'busy' ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 text-warning motion-safe:animate-spin" />
        ) : status.tone === 'done' ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        ) : (
          <QrCode className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="text-body font-medium text-foreground">
            {status.title}
          </p>
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
            {status.help}
          </p>
          {status.error && (
            <p role="alert" className="mt-1 text-caption text-error">
              {status.error}
            </p>
          )}
        </div>
      </div>

      {registration?.status === 'pending' && registration.qr_data_url && (
        <div className="flex flex-col items-center gap-3 rounded-lg px-4 py-5 ring-1 ring-surface-border">
          {/* QR codes need a white quiet zone to scan in dark mode too. */}
          <div className="size-60 max-w-full overflow-hidden rounded-lg bg-qr-quiet-zone p-2 ring-1 ring-surface-border">
            <img
              src={registration.qr_data_url}
              alt={spacedLabel(appName, '创建应用二维码')}
              className="size-full object-contain"
            />
          </div>
          <p className="text-caption text-muted-foreground tabular-nums">
            {registration.user_code && (
              <>
                确认码{' '}
                <span className="font-mono text-foreground">
                  {registration.user_code}
                </span>
                {' · '}
              </>
            )}
            {secondsLeft > 0
              ? `${formatCountdown(secondsLeft)} 后过期`
              : '即将过期'}
          </p>
          {registration.verification_url && (
            <a
              href={registration.verification_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-caption font-medium text-primary-text underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-11"
            >
              无法扫码？在浏览器中打开
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(state.phase === 'idle' || state.phase === 'starting') && (
          <Button
            type="button"
            size="sm"
            disabled={state.phase === 'starting'}
            onClick={() => void start()}
          >
            {state.phase === 'starting' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <QrCode className="size-3.5" />
            )}
            生成二维码
          </Button>
        )}
        {(state.phase === 'failed' ||
          (registration && !waiting && registration.status !== 'success')) && (
          <Button type="button" size="sm" onClick={() => void start()}>
            <RefreshCw className="size-3.5" />
            重新生成二维码
          </Button>
        )}
        {registration?.status === 'pending' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void cancel()}
          >
            <X className="size-3.5" />
            取消扫码
          </Button>
        )}
      </div>
    </div>
  );
}

function describeState(
  state: PanelState,
  appName: string,
): {
  title: string;
  help: string;
  tone: 'idle' | 'busy' | 'done';
  error?: string;
} {
  if (state.phase === 'idle') {
    return {
      title: '扫码创建应用',
      help: `生成二维码后，${spacedLabel('用手机', appName, '扫码并确认')}，HappyClaw 会自动创建应用并保存凭证，无需手动复制 App ID 和 App Secret。`,
      tone: 'idle',
    };
  }
  if (state.phase === 'starting') {
    return {
      title: '正在生成二维码',
      help: `${spacedLabel('正在向', appName, '申请创建应用的二维码')}。`,
      tone: 'busy',
    };
  }
  if (state.phase === 'failed') {
    return {
      title: '无法创建应用',
      help: '请重新生成二维码；如果多次失败，可以改用手动填写。',
      tone: 'idle',
      error: state.message,
    };
  }
  const { registration } = state;
  switch (registration.status) {
    case 'pending':
      return {
        title: '等待扫码',
        help: `${spacedLabel('请使用手机', appName, '扫码')}，并在手机上确认创建应用。`,
        tone: 'busy',
      };
    case 'creating':
      return {
        title: '已确认，正在保存',
        help: '应用已在手机上创建，HappyClaw 正在保存凭证并建立连接。',
        tone: 'busy',
      };
    case 'success':
      return {
        title: '应用已创建',
        help: '正在打开新账号。',
        tone: 'done',
      };
    case 'expired':
      return {
        title: '二维码已过期',
        help: '二维码有效期已过，请重新生成后扫码。',
        tone: 'idle',
      };
    case 'denied':
      return {
        title: '已拒绝授权',
        help: '手机上取消了创建。需要时可以重新生成二维码。',
        tone: 'idle',
      };
    default:
      return {
        title: '创建应用失败',
        help: '请重新生成二维码；如果多次失败，可以改用手动填写。',
        tone: 'idle',
        error: registration.error,
      };
  }
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
