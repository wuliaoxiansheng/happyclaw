import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FinalMarkdown, StreamingMarkdown } from './StreamingMarkdown';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { streamingMarkdownInterval } from '../../lib/streaming-interval';
import { thinkingLabel } from '../../utils/thinking-duration';

/** The collapsed row: a button when there is text to open, else a plain label. */
const HEADER_CLASS =
  '-ml-1.5 inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-caption text-muted-foreground pointer-coarse:h-10';
const HEADER_BUTTON_CLASS =
  'cursor-pointer transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none';

/**
 * Reasoning is a model's summary of its own thinking: short paragraphs with a
 * bold title. It reads as Markdown, set small and quiet beside the answer.
 */
const BODY_CLASS =
  'mt-1 mb-3 max-h-64 overflow-y-auto overscroll-contain border-l-2 border-surface-border pl-3 text-muted-foreground [&_[data-markdown-root]]:text-label [&_[data-markdown-root]]:leading-6 [&_[data-markdown-root]]:text-muted-foreground [&_strong]:text-foreground/85';
/**
 * The same text as one row of the process timeline: that has its own line on
 * the left, so the body brings none, and it sits under the row's label.
 */
const ROW_BODY_CLASS =
  'mt-0.5 mb-1.5 max-h-48 overflow-y-auto overscroll-contain text-muted-foreground [&_[data-markdown-root]]:text-label [&_[data-markdown-root]]:leading-6 [&_[data-markdown-root]]:text-muted-foreground [&_strong]:text-foreground/85';

export function ThinkingBody({
  id,
  text,
  live = false,
  groupJid,
  variant = 'block',
  className,
}: {
  id?: string;
  text: string;
  /** The text is still arriving: render it as streamed Markdown, throttled. */
  live?: boolean;
  groupJid?: string;
  /** `row`: inside a row of the process timeline, without a line of its own. */
  variant?: 'block' | 'row';
  className?: string;
}) {
  const shown = useThrottledValue(
    text,
    live ? streamingMarkdownInterval(text) : 0,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Text that is still arriving is followed to its end, unless the reader
  // scrolled up to re-read.
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (live && el && following.current) el.scrollTop = el.scrollHeight;
  }, [shown, live]);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (el) {
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    }
  };
  return (
    <div
      id={id}
      ref={scrollRef}
      onScroll={handleScroll}
      data-hc-thinking-body=""
      className={cn(variant === 'row' ? ROW_BODY_CLASS : BODY_CLASS, className)}
    >
      {live ? (
        <StreamingMarkdown content={shown} variant="docs" groupJid={groupJid} />
      ) : (
        <FinalMarkdown content={text} variant="docs" groupJid={groupJid} />
      )}
    </div>
  );
}

interface ThinkingBlockProps {
  text: string;
  /** Summary title of the latest reasoning, shown beside the label. */
  title?: string;
  /** Total thinking time; without text it is all there is to show. */
  durationMs?: number;
  /** The model is reasoning right now. */
  running?: boolean;
  /**
   * The reasoning text exists but this view does not show it (a proactive
   * workspace below `full`): an empty block then says nothing about the model.
   */
  withheld?: boolean;
  /** The text is still arriving. */
  live?: boolean;
  groupJid?: string;
  /** Controlled open state; leave out to let the block keep it. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

/**
 * The reasoning of a reply, collapsed to one row: "思考中…" while it goes on,
 * "已思考 X 秒" after, with the latest summary title. The streaming card and
 * the finished message render this same block, so the swap between them
 * keeps its height.
 */
export function ThinkingBlock({
  text,
  title,
  durationMs,
  running = false,
  withheld = false,
  live = false,
  groupJid,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  className,
}: ThinkingBlockProps) {
  const bodyId = useId();
  const [kept, setKept] = useState(defaultExpanded);
  const open = expanded ?? kept;
  const canOpen = text.trim().length > 0;
  const label = running ? '思考中…' : thinkingLabel(durationMs);
  // The model reasoned, for a while, and returned no summary of it. Say so
  // instead of leaving a row that looks as if it could be opened.
  const noSummary =
    !running &&
    !canOpen &&
    !withheld &&
    durationMs != null &&
    durationMs >= 1000;

  const toggle = () => {
    const next = !open;
    if (expanded === undefined) setKept(next);
    onExpandedChange?.(next);
  };

  const content = (
    <>
      <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
      <span className={cn('shrink-0', running && 'shimmer')}>{label}</span>
      {title && (
        <>
          <span aria-hidden="true" className="shrink-0 text-faint-foreground">
            ·
          </span>
          <span className="min-w-0 truncate text-faint-foreground">
            {title}
          </span>
        </>
      )}
      {noSummary && (
        <>
          <span aria-hidden="true" className="shrink-0 text-faint-foreground">
            ·
          </span>
          <span
            className="min-w-0 truncate text-faint-foreground"
            title="这个模型只返回加密的推理，不提供可读的思考摘要（ChatGPT 订阅的 GPT-6 系列多数如此）。"
            data-hc-no-summary=""
          >
            模型未返回思考内容
          </span>
        </>
      )}
      {canOpen && (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-150',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
      )}
    </>
  );

  return (
    <div className={cn('mb-2 font-sans', className)}>
      {canOpen ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          className={cn(HEADER_CLASS, HEADER_BUTTON_CLASS)}
        >
          {content}
        </button>
      ) : (
        <div className={HEADER_CLASS}>{content}</div>
      )}
      {canOpen && open && (
        <ThinkingBody id={bodyId} text={text} live={live} groupJid={groupJid} />
      )}
    </div>
  );
}
