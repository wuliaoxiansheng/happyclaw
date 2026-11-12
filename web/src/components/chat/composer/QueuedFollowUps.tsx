import { memo, useEffect, useId, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  CornerUpLeft,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';

import { ResponsiveMenu } from '../../common/ResponsiveMenu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Shortcut } from '../../common/Shortcut';
import type { FollowUpQueueAction, QueuedFollowUp } from '../../../stores/chat';
import {
  parseQueuedImageAttachments,
  queuedFollowUpLabel,
  type QueuedImagePreview,
} from '../composer-helpers';

interface QueuedFollowUpsPanelProps {
  queuedFollowUps: QueuedFollowUp[];
  /** Coarse pointer: one row per item, secondary actions in a menu. */
  touch: boolean;
  /** Start as a one-line summary that expands on demand. */
  collapsible: boolean;
  /** Fold an expanded queue back to its summary (keyboard came up). */
  collapseNow: boolean;
  actingOn: Set<string>;
  editingFollowUpId: string | null;
  editingFollowUpContent: string;
  handleFollowUpAction: (
    item: QueuedFollowUp,
    action: FollowUpQueueAction,
  ) => Promise<boolean>;
  beginEditingFollowUp: (item: QueuedFollowUp) => void;
  saveFollowUpEdit: (item: QueuedFollowUp) => Promise<void>;
  onEditChange: (value: string) => void;
  onCancelEdit: () => void;
  /** View-only queue (read-only guests): no reorder, edit, steer or delete. */
  readOnly?: boolean;
}

/**
 * Queued follow-ups at the top of the composer card (cindy's fused queue
 * card): one rounded card holds the queue and the editor. Memoized with stable
 * handlers, so typing in the composer does not re-render every queued message.
 */
export const QueuedFollowUpsPanel = memo(function QueuedFollowUpsPanel({
  queuedFollowUps,
  touch,
  collapsible,
  collapseNow,
  actingOn,
  editingFollowUpId,
  editingFollowUpContent,
  handleFollowUpAction,
  beginEditingFollowUp,
  saveFollowUpEdit,
  onEditChange,
  onCancelEdit,
  readOnly = false,
}: QueuedFollowUpsPanelProps) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (collapseNow) setExpanded(false);
  }, [collapseNow]);
  // Collapsing mid-edit only hides the editor; the edit itself is kept.
  const open = !collapsible || expanded;
  const steering = queuedFollowUps.some(
    (item) => item.delivery_mode === 'steer',
  );
  const summary = steering
    ? '正在停止当前回复，随后发送引导消息'
    : queuedFollowUps.length > 1
      ? `${queuedFollowUps.length} 条消息已排队，将合并为下一轮`
      : '1 条消息已排队';
  const collapsedSummary = steering
    ? '正在发送引导消息'
    : `${queuedFollowUps.length} 条已排队`;

  return (
    <div
      data-testid="queued-follow-ups"
      data-state={open ? 'open' : 'closed'}
      className="border-b border-surface-border"
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset pointer-coarse:h-10"
        >
          <Clock3 className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {open ? summary : collapsedSummary}
          </span>
          <span className="shrink-0 font-medium text-foreground/70">
            · {open ? '收起' : '展开'}
          </span>
          {open ? (
            <ChevronDown className="ml-auto size-3.5 shrink-0" />
          ) : (
            <ChevronUp className="ml-auto size-3.5 shrink-0" />
          )}
        </button>
      ) : (
        <div className="flex h-8 items-center gap-2 px-3 text-caption text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          <span>{summary}</span>
        </div>
      )}
      {open && (
        <div
          id={listId}
          data-testid="queued-follow-ups-list"
          className={cn(
            'overflow-y-auto overscroll-contain px-1 pb-1',
            collapsible ? 'max-h-[30dvh]' : 'max-h-56',
          )}
        >
          {queuedFollowUps.map((item, index) => (
            <QueuedFollowUpRow
              key={item.id}
              item={item}
              index={index}
              isLast={index === queuedFollowUps.length - 1}
              touch={touch}
              busy={actingOn.has(item.id)}
              editing={editingFollowUpId === item.id}
              editingFollowUpContent={editingFollowUpContent}
              handleFollowUpAction={handleFollowUpAction}
              beginEditingFollowUp={beginEditingFollowUp}
              saveFollowUpEdit={saveFollowUpEdit}
              onEditChange={onEditChange}
              onCancelEdit={onCancelEdit}
              readOnly={readOnly}
            />
          ))}
          {touch && !steering && !readOnly && (
            <p
              data-testid="queued-follow-ups-hint"
              className="px-2 pt-1 pb-1.5 text-micro text-faint-foreground"
            >
              「立即发送」{STEER_NOW_DESCRIPTION}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

interface QueuedFollowUpRowProps {
  item: QueuedFollowUp;
  index: number;
  isLast: boolean;
  touch: boolean;
  busy: boolean;
  editing: boolean;
  editingFollowUpContent: string;
  handleFollowUpAction: QueuedFollowUpsPanelProps['handleFollowUpAction'];
  beginEditingFollowUp: QueuedFollowUpsPanelProps['beginEditingFollowUp'];
  saveFollowUpEdit: QueuedFollowUpsPanelProps['saveFollowUpEdit'];
  onEditChange: QueuedFollowUpsPanelProps['onEditChange'];
  onCancelEdit: QueuedFollowUpsPanelProps['onCancelEdit'];
  readOnly: boolean;
}

const ROW_ICON_BUTTON =
  'flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:size-10';

/**
 * A steer stops the current reply and releases the queue with it: queued
 * messages go to the next turn together with this one (CLAUDE.md §6.4).
 */
const STEER_NOW_DESCRIPTION = '将停止当前回复，与已排队的消息一起立即发送';

function QueuedFollowUpRow({
  item,
  index,
  isLast,
  touch,
  busy,
  editing,
  editingFollowUpContent,
  handleFollowUpAction,
  beginEditingFollowUp,
  saveFollowUpEdit,
  onEditChange,
  onCancelEdit,
  readOnly,
}: QueuedFollowUpRowProps) {
  const steering = item.delivery_mode === 'steer';
  const locked = steering || item.delivery_status === 'promoting';
  const images = useMemo(
    () => parseQueuedImageAttachments(item.attachments),
    [item.attachments],
  );
  const label = queuedFollowUpLabel(item.content, images.length);

  const sendNowButton = (
    <button
      type="button"
      disabled={busy || locked}
      onClick={() => void handleFollowUpAction(item, 'steer')}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-caption font-medium text-primary-text transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
      aria-label={`立即发送：${label}`}
      aria-description={STEER_NOW_DESCRIPTION}
    >
      {busy || locked ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <CornerUpLeft className="h-3.5 w-3.5" />
      )}
      {locked ? '发送中' : '立即发送'}
    </button>
  );
  // Touch has no hover: the panel says what it does under the list instead.
  const sendNow = touch ? (
    sendNowButton
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{sendNowButton}</TooltipTrigger>
      <TooltipContent side="top">{STEER_NOW_DESCRIPTION}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="group/queued flex min-w-0 items-start gap-2 rounded-lg px-2 py-1 focus-within:bg-surface-hover hover:bg-surface-hover">
      <span className="mt-1.5 shrink-0 text-micro font-medium text-faint-foreground tabular-nums pointer-coarse:mt-3">
        {index + 1}
      </span>
      {editing ? (
        <div className="min-w-0 flex-1 space-y-2">
          <textarea
            value={editingFollowUpContent}
            onChange={(event) => onEditChange(event.target.value)}
            onFocus={(event) => {
              // The editor opens with the caret where the message ends, not
              // before it; later focus keeps wherever the user clicked.
              const field = event.currentTarget;
              if (field.dataset.caretPlaced) return;
              field.dataset.caretPlaced = 'true';
              field.setSelectionRange(field.value.length, field.value.length);
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              ) {
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCancelEdit();
              } else if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                void saveFollowUpEdit(item);
              }
            }}
            rows={2}
            autoFocus
            className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-caption leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:text-base"
            aria-label="编辑排队消息"
          />
          <div className="flex items-center justify-end gap-1">
            <span className="mr-auto text-micro text-faint-foreground pointer-coarse:hidden">
              Esc 取消 · <Shortcut keys="mod+enter" /> 保存
            </span>
            <button
              type="button"
              onClick={onCancelEdit}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted-foreground hover:bg-surface-hover hover:text-foreground pointer-coarse:h-10"
            >
              <X className="h-3.5 w-3.5" />
              取消
            </button>
            <button
              type="button"
              disabled={busy || !editingFollowUpContent.trim()}
              onClick={() => void saveFollowUpEdit(item)}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-caption font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <QueuedFollowUpContent
            content={item.content}
            images={images}
            touch={touch}
          />
          {readOnly ? null : touch ? (
            // One row per item on touch: the primary action inline, the
            // rest behind a menu instead of a second row of buttons.
            <div className="flex shrink-0 items-center gap-0.5 -mr-1.5">
              {sendNow}
              <ResponsiveMenu
                title="排队消息操作"
                trigger={
                  <button
                    type="button"
                    disabled={busy || locked}
                    className={ROW_ICON_BUTTON}
                    aria-label={`更多操作：${label}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                }
                // Reordering is what a drag would do on a desktop list; on
                // touch it is these two rows.
                groups={[
                  [
                    {
                      label: '上移',
                      icon: ChevronUp,
                      disabled: index === 0,
                      onSelect: () =>
                        void handleFollowUpAction(item, 'move_up'),
                    },
                    {
                      label: '下移',
                      icon: ChevronDown,
                      disabled: isLast,
                      onSelect: () =>
                        void handleFollowUpAction(item, 'move_down'),
                    },
                    {
                      label: '编辑',
                      icon: Pencil,
                      onSelect: () => beginEditingFollowUp(item),
                    },
                  ],
                  [
                    {
                      label: '删除',
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => void handleFollowUpAction(item, 'cancel'),
                    },
                  ],
                ]}
              />
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-0.5 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/queued:opacity-100 pointer-fine:group-focus-within/queued:opacity-100">
              <button
                type="button"
                disabled={busy || locked || index === 0}
                onClick={() => void handleFollowUpAction(item, 'move_up')}
                className={ROW_ICON_BUTTON}
                aria-label={`上移：${label}`}
                title="上移"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={busy || locked || isLast}
                onClick={() => void handleFollowUpAction(item, 'move_down')}
                className={ROW_ICON_BUTTON}
                aria-label={`下移：${label}`}
                title="下移"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={busy || locked}
                onClick={() => beginEditingFollowUp(item)}
                className={ROW_ICON_BUTTON}
                aria-label={`编辑：${label}`}
                title="编辑"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              {sendNow}
              <button
                type="button"
                disabled={busy || locked}
                onClick={() => void handleFollowUpAction(item, 'cancel')}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-10"
                aria-label={`删除排队消息：${label}`}
                title="删除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QueuedFollowUpContent({
  content,
  images,
  touch,
}: {
  content: string;
  images: QueuedImagePreview[];
  touch: boolean;
}) {
  const text = content.trim();
  // Touch clamps a message to two lines and has no tooltip for the rest: a
  // tap on it shows it whole.
  const [whole, setWhole] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5 pt-1 pointer-coarse:pt-2.5">
      {images.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {images.slice(0, 3).map((image, i) => (
            <img
              key={i}
              src={image.src}
              alt=""
              className="size-5 rounded object-cover ring-1 ring-surface-border"
            />
          ))}
          {images.length > 3 && (
            <span className="text-micro text-muted-foreground">
              +{images.length - 3}
            </span>
          )}
        </span>
      )}
      <span
        className={cn(
          'block min-w-0 flex-1 text-caption leading-5 break-words whitespace-pre-wrap',
          text ? 'text-foreground/85' : 'text-muted-foreground',
          touch && !whole && 'line-clamp-2',
        )}
        title={touch ? undefined : text || undefined}
        {...(touch && {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': whole,
          onClick: () => setWhole((value) => !value),
        })}
      >
        {queuedFollowUpLabel(content, images.length)}
      </span>
    </div>
  );
}
