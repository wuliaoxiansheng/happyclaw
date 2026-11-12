import type { ReactNode } from 'react';
import {
  FileUp,
  FolderUp,
  Image as ImageIcon,
  Loader2,
  Paintbrush,
  Plus,
  TerminalSquare,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { IconButton } from '../../common/IconButton';
import { Shortcut } from '../../common/Shortcut';
import { SendButton, type SendButtonGlyph } from './cindy/SendButton';
import { ActionSheet, type SheetAction } from './ActionSheet';
import { useDockOverlay } from './composerDock';

/**
 * Composer toolbar pill (cindy's dropdown tier): bare at rest, an outline and
 * hover fill on hover or while its menu is open. A phone gets cindy's 34px
 * tool button with a light fill and a hairline, its touch target padded to
 * 44px; a touch tablet keeps 40px.
 */
const COMPOSER_PILL =
  'relative size-[30px] shrink-0 rounded-full border border-transparent text-muted-foreground hover:border-surface-border hover:bg-surface-hover hover:text-foreground data-[state=open]:border-surface-border data-[state=open]:bg-surface-hover lg:pointer-coarse:size-10 phone:size-[34px] phone:border-surface-border phone:bg-muted phone:before:absolute phone:before:-inset-[5px]';

interface ComposerToolbarProps {
  canAttach: boolean;
  uploading: boolean;
  onPickImages: () => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onResetSession?: () => void;
  onToggleTerminal?: () => void;
  /** A narrow row: reset and terminal move into the + menu. */
  foldActions?: boolean;
  /** A phone: + opens a bottom sheet instead of a dropdown. */
  phone?: boolean;
  /**
   * The resting phone pill: +, the model's compact chip and the primary
   * action, laid out by the card around the editor (the toolbar box itself
   * dissolves).
   */
  collapsed?: boolean;
  /**
   * The context ring, after the tools. Its slot keeps its width whether or
   * not the ring has data, so the ring appearing moves nothing.
   */
  contextUsage?: ReactNode;
  modelSelector?: ReactNode;
  /** A stop control beside the primary action (a draft holds that spot). */
  showSideStop: boolean;
  stopping: boolean;
  stopDisabled: boolean;
  onStop: () => void;
  send: {
    glyph: SendButtonGlyph;
    disabled: boolean;
    label: string;
    onClick: () => void;
    /** Escape stops; the alternate follow-up mode and its shortcut. */
    escapeStops: boolean;
    alternate?: { label: string; shortcut: string };
  };
}

interface PlusAction extends SheetAction {
  /** Only in the dropdown (a phone has no folder picker). */
  desktopOnly?: boolean;
}

/**
 * cindy's toolbar: attach, reset and terminal on the left; the model, stop
 * and send on the right (a phone: the model right after +). The model
 * trigger gives way first, so a narrow row truncates it and never squeezes
 * the tools or the send button. Below 480px reset and terminal fold into
 * the + menu, leaving the model more room.
 */
export function ComposerToolbar({
  canAttach,
  uploading,
  onPickImages,
  onPickFiles,
  onPickFolder,
  onResetSession,
  onToggleTerminal,
  foldActions = false,
  phone = false,
  collapsed = false,
  contextUsage,
  modelSelector,
  showSideStop,
  stopping,
  stopDisabled,
  onStop,
  send,
}: ComposerToolbarProps) {
  const menuReset = foldActions && !!onResetSession;
  const menuTerminal = foldActions && !!onToggleTerminal;
  // Named after what the menu offers.
  const plusLabel = menuReset || menuTerminal ? '更多操作' : '添加文件';
  const plusDisabled = uploading && !menuReset && !menuTerminal;

  const attachActions: PlusAction[] = canAttach
    ? [
        // Images go inline with the message, not through the upload
        // channel, so an upload in progress allows them.
        { label: '添加图片', icon: ImageIcon, onSelect: onPickImages },
        {
          label: '上传文件',
          icon: FileUp,
          onSelect: onPickFiles,
          disabled: uploading,
        },
        {
          label: '上传文件夹',
          icon: FolderUp,
          onSelect: onPickFolder,
          disabled: uploading,
          desktopOnly: true,
        },
      ]
    : [];
  const sessionActions: PlusAction[] = [
    ...(menuReset
      ? [{ label: '清除上下文', icon: Paintbrush, onSelect: onResetSession! }]
      : []),
    ...(menuTerminal
      ? [{ label: '终端', icon: TerminalSquare, onSelect: onToggleTerminal! }]
      : []),
  ];
  const plusGroups = [attachActions, sessionActions].filter(
    (group) => group.length > 0,
  );
  const [plusSheetOpen, setPlusSheetOpen] = useDockOverlay();
  // The model (and effort): right before send on a desktop, right after +
  // on a phone. The padding keeps the triggers' focus rings inside the
  // clip. In the resting pill the picker shows its compact chip (its own
  // padded touch target reaches past the clip, so none here).
  const modelSlot = modelSelector && (
    <div
      data-composer-model-slot
      className={cn(
        'flex min-w-0 items-center gap-1',
        collapsed ? 'shrink-0' : '-m-0.5 overflow-hidden p-0.5',
        !phone && 'justify-end',
      )}
    >
      {modelSelector}
    </div>
  );

  return (
    <div
      data-composer-toolbar
      className={cn(
        // Collapsed, the toolbar box dissolves so + and send sit in the
        // pill's own row around the editor.
        collapsed
          ? 'contents'
          : 'mt-[2px] flex min-w-0 items-center gap-1 select-none',
      )}
    >
      {/* Fixed buttons: only the model slot gives way. On a phone the
          slot sits in this group right after + (cindy's order), so the
          group itself gives way through it. */}
      <div
        data-composer-tools
        className={cn(
          'flex items-center gap-1',
          phone ? 'min-w-0' : 'shrink-0',
          // Collapsed, the tools lead the pill's row: + | text | send.
          collapsed && 'order-first',
        )}
      >
        {plusGroups.length > 0 &&
          (phone ? (
            // A phone lists the same actions as rows of a bottom sheet.
            <ActionSheet
              open={plusSheetOpen}
              onOpenChange={setPlusSheetOpen}
              title={plusLabel}
              description="添加附件或管理当前会话"
              groups={plusGroups.map((group) =>
                group.filter((action) => !action.desktopOnly),
              )}
              data-composer-plus-sheet
              trigger={
                <IconButton
                  label={plusLabel}
                  icon={<Plus />}
                  disabled={plusDisabled}
                  hideTooltip
                  className={COMPOSER_PILL}
                />
              }
            />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={plusLabel}
                  icon={<Plus />}
                  disabled={plusDisabled}
                  tooltipSide="top"
                  className={COMPOSER_PILL}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-44">
                {plusGroups.map((group, index) => [
                  index > 0 && (
                    <DropdownMenuSeparator key={`separator-${index}`} />
                  ),
                  ...group.map(
                    ({
                      label,
                      icon: Icon,
                      onSelect,
                      disabled,
                      desktopOnly,
                    }) => (
                      <DropdownMenuItem
                        key={label}
                        disabled={disabled}
                        className={desktopOnly ? 'max-lg:hidden' : undefined}
                        onClick={onSelect}
                      >
                        <Icon />
                        {label}
                      </DropdownMenuItem>
                    ),
                  ),
                ])}
              </DropdownMenuContent>
            </DropdownMenu>
          ))}
        {phone && modelSlot}
        {onResetSession && !foldActions && !collapsed && (
          <IconButton
            label="清除当前会话上下文"
            icon={<Paintbrush />}
            onClick={onResetSession}
            tooltipSide="top"
            className={COMPOSER_PILL}
          />
        )}
        {onToggleTerminal && !foldActions && !collapsed && (
          <IconButton
            label="终端"
            icon={<TerminalSquare />}
            onClick={onToggleTerminal}
            tooltipSide="top"
            className={COMPOSER_PILL}
          />
        )}
        {contextUsage && (
          <div
            data-composer-context
            className={cn(
              'ml-1 flex h-[30px] w-[3.25rem] shrink-0 items-center',
              collapsed && 'hidden',
            )}
          >
            {contextUsage}
          </div>
        )}
      </div>

      {!collapsed && <div className="flex-1" />}

      {!phone && modelSlot}

      {showSideStop && !collapsed && (
        <IconButton
          label="停止当前运行"
          icon={
            stopping ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <span className="block size-2.5 rounded-[1.5px] bg-current" />
            )
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={onStop}
          disabled={stopDisabled}
          tooltipSide="top"
          className={COMPOSER_PILL}
        />
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <SendButton
            glyph={send.glyph}
            disabled={send.disabled}
            onClick={send.onClick}
            ariaLabel={send.label}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="flex-col items-start">
          <span className="flex items-center gap-1.5">
            {send.label}
            {send.escapeStops && <Shortcut keys="escape" />}
          </span>
          {send.alternate && (
            <span className="flex items-center gap-1.5 opacity-70">
              {send.alternate.label}
              <Shortcut keys={send.alternate.shortcut} />
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
