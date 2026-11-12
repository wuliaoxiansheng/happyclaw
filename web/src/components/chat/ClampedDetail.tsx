import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { useComposedRefs } from 'radix-ui/internal';
import { Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsPhone } from '../layout/phone';
import { DetailSheet } from './DetailSheet';

type BoxProps = Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'> & {
  [data: `data-${string}`]: string | undefined;
};

interface ClampedDetailProps extends BoxProps {
  /** Names the full view: "工具输出", "思考". */
  title: string;
  /** The height the box keeps (`max-h-*`), on every device. */
  maxHeightClass: string;
  /** Rendered as a `<pre>` (tool output) instead of a `<div>`. */
  pre?: boolean;
  /** A live box shows its end: what is cut off is above. */
  cutAt?: 'end' | 'start';
  children: ReactNode;
}

const FADE: Record<'end' | 'start', string> = {
  end: '[mask-image:linear-gradient(to_bottom,#000_calc(100%-2rem),transparent)]',
  start:
    '[mask-image:linear-gradient(to_top,#000_calc(100%-2rem),transparent)]',
};

/**
 * A box of second-hand text inside a reply (a tool's output, reasoning, a
 * note). With a mouse it scrolls on its own, as it always has. A phone has no
 * box in a box (cindy, MessageRenderer): the box does not scroll, so a finger
 * on it scrolls the conversation, and text that does not fit fades out over
 * a 「查看全部」 that opens all of it in a bottom sheet. The box can still be
 * scrolled by code (a live box follows its end).
 */
export const ClampedDetail = forwardRef<HTMLElement, ClampedDetailProps>(
  function ClampedDetail(
    {
      title,
      maxHeightClass,
      pre = false,
      cutAt = 'end',
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const isPhone = useIsPhone();
    const Tag = pre ? 'pre' : 'div';
    const box = useRef<HTMLElement>(null);
    const content = useRef<HTMLElement>(null);
    const boxRef = useComposedRefs(ref, box);
    const [overflows, setOverflows] = useState(false);
    const [open, setOpen] = useState(false);

    // On a phone the box (the clip) holds the text in a block of its own, so
    // one observer of the two sees the text grow and the width change.
    useEffect(() => {
      const element = box.current;
      const inner = content.current;
      if (!isPhone || !element || !inner) return;
      const measure = () =>
        setOverflows(element.scrollHeight - element.clientHeight > 1);
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      observer.observe(inner);
      return () => observer.disconnect();
    }, [isPhone]);

    if (!isPhone) {
      return (
        <Tag
          ref={boxRef as never}
          className={cn(
            maxHeightClass,
            'overflow-y-auto overscroll-contain',
            className,
          )}
          {...rest}
        >
          {children}
        </Tag>
      );
    }
    return (
      <>
        <div
          ref={boxRef as never}
          data-hc-clamped={overflows ? 'cut' : 'whole'}
          className={cn(
            maxHeightClass,
            'overflow-hidden',
            overflows && FADE[cutAt],
          )}
          {...rest}
        >
          <Tag ref={content as never} className={className}>
            {children}
          </Tag>
        </div>
        {overflows && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="-ml-1 inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-md px-1 font-sans text-caption font-medium text-muted-foreground transition-colors active:bg-surface-hover"
          >
            <Maximize2 className="size-3.5" aria-hidden="true" />
            查看全部
          </button>
        )}
        {open && (
          <DetailSheet title={title} onClose={() => setOpen(false)}>
            <Tag className={className}>{children}</Tag>
          </DetailSheet>
        )}
      </>
    );
  },
);
