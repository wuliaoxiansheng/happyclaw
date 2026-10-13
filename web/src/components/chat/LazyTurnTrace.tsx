import type { ComponentType } from 'react';
import { ChevronRight, ListTree, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatStore, type Message } from '../../stores/chat';
import { useStreamLayout } from '../../hooks/useStreamLayout';

/** The same collapsed row the loaded reasoning and trace use, as a button. */
const ROW_CLASS =
  '-ml-1.5 inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-default pointer-coarse:h-10';

/**
 * The row of the process card's summary (ProcessHeader): the whole width of the
 * message, with its chevron at the end, so the row that is pressed and the card
 * that replaces it are the same height and look.
 */
const CARD_ROW_CLASS =
  '-mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-label text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-default pointer-coarse:min-h-10';

const RETRY_NOTE = ' · 暂时无法加载，点击重试';

function LazyRow({
  icon: Icon,
  label,
  loading,
  failed,
  onClick,
  card = false,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
  label: string;
  loading: boolean;
  failed: boolean;
  onClick: () => void;
  /** Shaped like the process card's summary row, not like the older rows. */
  card?: boolean;
}) {
  const icon = loading ? (
    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
  ) : (
    <Icon
      className={cn('size-3.5 shrink-0', card && 'text-faint-foreground')}
      aria-hidden="true"
    />
  );
  const retry = failed && !loading;
  const chevron = (
    <ChevronRight
      className={cn(
        'size-3.5 shrink-0',
        card && 'text-faint-foreground',
        loading && 'opacity-0',
      )}
      aria-hidden="true"
    />
  );
  return (
    <div className="mb-2 font-sans">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
        className={card ? CARD_ROW_CLASS : ROW_CLASS}
      >
        {icon}
        {card ? (
          <span className="min-w-0 flex-1 truncate">
            {label}
            {retry && (
              <span className="text-faint-foreground">{RETRY_NOTE}</span>
            )}
          </span>
        ) : (
          <>
            <span className="shrink-0">{label}</span>
            {retry && (
              <span className="min-w-0 truncate text-faint-foreground">
                {RETRY_NOTE.trimStart()}
              </span>
            )}
          </>
        )}
        {chevron}
      </button>
    </div>
  );
}

/**
 * The process of a reply this tab did not stream (after a reload, or on an
 * older page of the history): the server kept it, so it shows as collapsed
 * rows, loaded when one is opened, and they give way to the real ones once the
 * caches hold the turn. The timeline layout has one row, "处理过程": whether
 * the server kept the ordered steps (the settled card, opened) or only the
 * reasoning and the trace of an older turn (their two rows) is known once it
 * is loaded. The classic layout always has the two rows.
 */
export function LazyTurnTrace({
  message,
  reasoning,
  onRequest,
}: {
  message: Pick<Message, 'id' | 'chat_jid' | 'turn_id'>;
  /** The server keeps reasoning text for this workspace (not just activity). */
  reasoning: boolean;
  /** Which row asked, so the loaded block opens at once. */
  onRequest: (row: 'thinking' | 'trace' | 'process') => void;
}) {
  const { layout } = useStreamLayout();
  const status = useChatStore((s) => s.turnTraceStatus[message.id]);
  // Loaded, and the bubble still asks: the steps hold nothing this layout or
  // level shows, so there is nothing left to load (the row would only spin).
  const loadedSteps = useChatStore(
    (s) => s.stepsCache[message.id] !== undefined,
  );
  const loadTurnTrace = useChatStore((s) => s.loadTurnTrace);
  if (status === 'empty' || loadedSteps) return null;
  const loading = status === 'loading';
  const failed = status === 'failed';
  const ask = (row: 'thinking' | 'trace' | 'process') => () => {
    onRequest(row);
    void loadTurnTrace(message);
  };
  if (layout === 'timeline') {
    return (
      <LazyRow
        icon={Sparkles}
        label="处理过程"
        loading={loading}
        failed={failed}
        onClick={ask('process')}
        card
      />
    );
  }
  return (
    <>
      {reasoning && (
        <LazyRow
          icon={Sparkles}
          label="思考过程"
          loading={loading}
          failed={failed}
          onClick={ask('thinking')}
        />
      )}
      <LazyRow
        icon={ListTree}
        label="执行详情"
        loading={loading}
        failed={failed && !reasoning}
        onClick={ask('trace')}
      />
    </>
  );
}
