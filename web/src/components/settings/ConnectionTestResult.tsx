import { CheckCircle2, CircleX, Loader2, TriangleAlert } from 'lucide-react';

import { errorCopy, type TestOutcome } from './model-connections';

interface ConnectionTestResultProps {
  outcome: TestOutcome | null;
  testing?: boolean;
  /** The test request itself failed (rate limit, network). */
  requestError?: string | null;
}

/** The outcome of one connection test: what happened and what to do next. */
export function ConnectionTestResult({
  outcome,
  testing = false,
  requestError = null,
}: ConnectionTestResultProps) {
  if (testing) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-caption text-muted-foreground ring-1 ring-surface-border"
      >
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        正在测试连接…
      </div>
    );
  }
  if (requestError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-caption leading-5 ring-1 ring-surface-border"
      >
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="text-foreground">测试没有完成</div>
          <div className="break-words text-muted-foreground">
            {requestError}
          </div>
        </div>
      </div>
    );
  }
  if (!outcome) return null;

  if (outcome.ok) {
    const details = [
      outcome.model,
      outcome.latencyMs !== null ? `${outcome.latencyMs} ms` : null,
    ].filter(Boolean);
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-caption leading-5 ring-1 ring-surface-border"
      >
        <CheckCircle2
          className="mt-0.5 size-4 shrink-0 text-success"
          aria-hidden="true"
        />
        <div className="min-w-0 text-foreground">
          连接成功
          {details.length > 0 && (
            <span className="font-mono">（{details.join(' · ')}）</span>
          )}
        </div>
      </div>
    );
  }

  const copy = errorCopy(outcome.code);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-caption leading-5 ring-1 ring-surface-border"
    >
      <CircleX
        className="mt-0.5 size-4 shrink-0 text-error"
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium text-foreground">
          {copy.title}
          {outcome.model && (
            <span className="font-mono font-normal text-muted-foreground">
              {' '}
              · {outcome.model}
            </span>
          )}
        </div>
        <div className="text-muted-foreground">{copy.hint}</div>
        {outcome.message && (
          <details className="group/raw">
            <summary className="w-fit cursor-pointer text-faint-foreground select-none hover:text-muted-foreground">
              原始信息
            </summary>
            <div className="mt-1 font-mono text-micro break-all text-faint-foreground">
              {outcome.message}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
