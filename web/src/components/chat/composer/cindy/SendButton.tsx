/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/SendButton.tsx
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. Voice, companion-call and create-agent variants are dropped;
 * HappyClaw adds the queue glyph and a busy spinner to the same stacked,
 * cross-fading icon layers, painted with HappyClaw tokens.
 *
 * Send / Stop button: one round 30px target whose glyph cross-fades in place
 * (send arrow, queue, stop square, spinner) instead of swapping elements.
 */
import { forwardRef, type ReactNode } from 'react';
import { ArrowUp, ListPlus, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export type SendButtonGlyph = 'send' | 'queue' | 'stop' | 'busy';

interface SendButtonProps {
  glyph: SendButtonGlyph;
  disabled: boolean;
  onClick: () => void;
  ariaLabel: string;
}

const LAYER =
  'col-start-1 row-start-1 flex items-center justify-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none';
const HIDDEN = 'scale-75 opacity-0';
const SHOWN = 'scale-100 opacity-100';

export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(
  function SendButton({ glyph, disabled, onClick, ariaLabel, ...rest }, ref) {
    const layer = (name: SendButtonGlyph, icon: ReactNode) => (
      <span className={cn(LAYER, glyph === name ? SHOWN : HIDDEN)}>{icon}</span>
    );
    const idle = disabled && glyph !== 'busy';
    return (
      <button
        ref={ref}
        type="button"
        // Tooltip triggers pass their handlers through.
        {...rest}
        disabled={disabled}
        // Keep the caret (and the mobile keyboard) in the composer.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        aria-label={ariaLabel}
        className={cn(
          'relative flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full',
          'transition-[color,background-color,transform] duration-150 motion-reduce:transition-none',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised focus-visible:outline-none',
          // A phone: cindy's 34px send, its touch target padded to 44px.
          'lg:pointer-coarse:size-10 phone:size-[34px] phone:before:absolute phone:before:-inset-[5px]',
          idle
            ? 'cursor-not-allowed bg-muted text-faint-foreground'
            : 'bg-foreground text-background hover:bg-foreground/85 active:scale-95',
        )}
      >
        <span className="grid size-4 place-items-center" aria-hidden>
          {layer('send', <ArrowUp className="size-4" strokeWidth={2.4} />)}
          {layer('queue', <ListPlus className="size-4" />)}
          {layer(
            'stop',
            <span className="block size-2.5 rounded-[1.5px] bg-current" />,
          )}
          {layer('busy', <Loader2 className="size-4 animate-spin" />)}
        </span>
      </button>
    );
  },
);
