import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useIsPhone } from '../layout/phone';

/** A user message longer than this many lines folds (cindy userMessageCollapse). */
export const USER_MESSAGE_COLLAPSE_LINES = 14;
/** How many lines a folded message keeps. */
export const USER_MESSAGE_COLLAPSED_LINES = 10;

/**
 * The text of a user's message. On a phone it is set at the reply's size
 * (cindy: 17/26 for every message), so the two read as one conversation, and
 * a long one (a pasted log, a long prompt) folds to its first ten lines with
 * 「展开」 under it, so the reply it asked for is not a long scroll away.
 * Lines are counted as laid out, not as typed: a long paragraph wraps into
 * many.
 */
export function CollapsibleUserText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const collapsible = useIsPhone();
  const ref = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Measured unfolded, before paint, so a long message never shows whole
  // first. Measured again when the width changes (rotation).
  useLayoutEffect(() => {
    const element = ref.current;
    if (!collapsible || !element) {
      setLong(false);
      return;
    }
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      if (!lineHeight) return;
      // While folded the paragraph is clamped; its full height is its
      // scrollHeight either way.
      setLong(
        element.scrollHeight >
          lineHeight * USER_MESSAGE_COLLAPSE_LINES + lineHeight / 2,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, collapsible]);

  const folded = long && !expanded;
  return (
    <>
      <p
        ref={ref}
        data-hc-user-text={folded ? 'folded' : undefined}
        className={cn(
          'text-body-lg break-words whitespace-pre-wrap phone:text-reply phone:leading-(--text-reply--line-height)',
          folded && 'line-clamp-10',
          className,
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="-mb-2 inline-flex h-11 cursor-pointer items-center text-label font-medium text-muted-foreground transition-colors active:text-foreground"
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  );
}
