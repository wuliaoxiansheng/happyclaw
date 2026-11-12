import { memo } from 'react';

import { cn } from '@/lib/utils';
import { useDisplayMode } from '../../../hooks/useDisplayMode';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import type { QueuedFollowUp } from '../../../stores/chat';
import { QueuedFollowUpsPanel } from './QueuedFollowUps';

const noopFollowUpAction = async () => false;
const noop = () => {};
const noopAsync = async () => {};
const NO_ACTING = new Set<string>();

interface ReadOnlyComposerProps {
  notice: string;
  queuedFollowUps?: QueuedFollowUp[];
}

/**
 * Replaces the composer for read-only viewers (guests): the queued messages
 * stay visible, but nothing can be typed, sent, stopped or reordered. Lives
 * outside MessageInput so a guest never loads the editor bundle.
 */
export const ReadOnlyComposer = memo(function ReadOnlyComposer({
  notice,
  queuedFollowUps = [],
}: ReadOnlyComposerProps) {
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  const isTouchInput = useMediaQuery('(pointer: coarse) and (hover: none)');
  const isPhoneWidth = useMediaQuery('(max-width: 639px)');
  return (
    <div
      data-hc-composer
      data-readonly="true"
      className="relative w-full bg-background pt-1 pb-3 max-lg:border-t max-lg:border-surface-border max-lg:bg-background/80 max-lg:backdrop-blur-xl"
      style={{
        paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div
        className={
          isCompact ? 'mx-auto px-4' : 'mx-auto max-w-3xl px-4 lg:px-6'
        }
      >
        <div
          className={cn(
            'overflow-hidden border border-surface-border bg-surface-raised',
            isCompact ? 'rounded-lg' : 'rounded-[12px]',
          )}
        >
          {queuedFollowUps.length > 0 && (
            <QueuedFollowUpsPanel
              queuedFollowUps={queuedFollowUps}
              touch={isTouchInput}
              collapsible={isTouchInput || isPhoneWidth}
              collapseNow={false}
              actingOn={NO_ACTING}
              editingFollowUpId={null}
              editingFollowUpContent=""
              handleFollowUpAction={noopFollowUpAction}
              beginEditingFollowUp={noop}
              saveFollowUpEdit={noopAsync}
              onEditChange={noop}
              onCancelEdit={noop}
              readOnly
            />
          )}
          <div
            role="status"
            className="flex min-h-11 items-center justify-center px-4 py-2.5 text-center text-caption text-muted-foreground"
          >
            {notice}
          </div>
        </div>
      </div>
    </div>
  );
});
