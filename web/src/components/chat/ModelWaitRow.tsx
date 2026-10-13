import { Sparkles } from 'lucide-react';
import { useAfterDelay, useTick } from '../../hooks/useTick';
import { formatRunElapsed } from '../../lib/run-phase';

/** After this long without a byte the skeleton stops promising words soon. */
export const MODEL_WAIT_SKELETON_SECONDS = 5;

/** Whole seconds this request has taken, if we know when it began. */
export function modelWaitSeconds(
  since: number | undefined,
  now: number,
): number | null {
  return since != null ? Math.max(0, Math.floor((now - since) / 1000)) : null;
}

/**
 * Where the model's words will be: a few skeleton lines, which give way to a
 * line that says so once the wait is long. Some models reason silently and
 * answer only at the end (the ChatGPT subscription's give no readable summary
 * at all), so pulsing at words that will not come would be a lie.
 */
export function ModelWaitBody({ seconds }: { seconds: number | null }) {
  const silent = seconds != null && seconds >= MODEL_WAIT_SKELETON_SECONDS;
  return silent ? (
    <p
      className="py-0.5 text-caption text-faint-foreground"
      data-hc-model-silent=""
    >
      仍在等待模型返回内容。有的模型（如 ChatGPT
      订阅）静默推理，不提供思考摘要，只显示用时。
    </p>
  ) : (
    <div aria-hidden="true" className="space-y-2 py-0.5">
      <div className="h-3 w-3/4 animate-pulse rounded bg-surface-selected" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-surface-selected" />
    </div>
  );
}

/**
 * The model is at work and nothing has come back yet: a quiet row with how
 * long this request has taken and a few skeleton lines where its words will
 * be. The first wait of a reply shows at once; a short one between tools only
 * once it has lasted a moment, so a quick turn does not flash it.
 */
export function ModelWaitRow({
  active,
  since,
  delayMs = 0,
}: {
  active: boolean;
  /** When this request began (ms). */
  since?: number;
  delayMs?: number;
}) {
  const visible = useAfterDelay(active, delayMs);
  const now = useTick(visible);
  if (!visible) return null;
  const seconds = modelWaitSeconds(since, now);
  return (
    <div className="mb-2 font-sans" data-hc-model-wait="">
      <div className="-ml-1.5 flex h-7 items-center gap-1.5 px-1.5 text-caption text-muted-foreground pointer-coarse:h-10">
        <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shimmer">正在思考…</span>
        {seconds != null && seconds >= 1 && (
          <span className="text-faint-foreground tabular-nums">
            {formatRunElapsed(seconds)}
          </span>
        )}
      </div>
      <div className="mt-1 border-l-2 border-surface-border pl-3">
        <ModelWaitBody seconds={seconds} />
      </div>
    </div>
  );
}
