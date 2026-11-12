import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { File, Folder, Loader2, Sparkles, SquareSlash } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ComposerPaletteState, PaletteItem } from './useComposerPalette';

/** Id of a palette row, for the editor's `aria-activedescendant`. */
export function paletteOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/** The list's height: 16rem, or less when the keyboard leaves less room. */
const LIST_MAX_PX = 256;
/** Never shorter than about three rows. */
const LIST_MIN_PX = 112;
/** Room kept between the panel and the header above it. */
const TOP_GAP_PX = 8;
/** The panel's mb-2 above the card. */
const PANEL_MARGIN_PX = 8;

/**
 * Cap the list so the panel ends below the conversation header in what is
 * visible now (the keyboard shrinks the visual viewport, and iOS may scroll
 * it), following the viewport while the panel is open.
 */
function useFitAboveAnchor(
  panelRef: RefObject<HTMLDivElement | null>,
  listRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const list = listRef.current;
    const anchor = panel?.parentElement;
    if (!panel || !list || !anchor) return;
    const host = anchor.closest<HTMLElement>('[data-composer-dock-host]');
    const header = host
      ? parseFloat(
          getComputedStyle(host).getPropertyValue('--chat-header-height'),
        ) || 0
      : 0;
    let frame = 0;
    const fit = () => {
      frame = 0;
      const ceiling =
        Math.max(
          window.visualViewport?.offsetTop ?? 0,
          host?.getBoundingClientRect().top ?? 0,
        ) +
        header +
        TOP_GAP_PX;
      // What the panel adds besides the list (border, the key hints, its
      // margin) comes off the list.
      const chrome = panel.offsetHeight - list.offsetHeight + PANEL_MARGIN_PX;
      const room = anchor.getBoundingClientRect().top - ceiling - chrome;
      list.style.maxHeight = `${Math.max(LIST_MIN_PX, Math.min(LIST_MAX_PX, room))}px`;
    };
    fit();
    // Viewport events come many per second while iOS scrolls: once a frame.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [panelRef, listRef]);
}

const ICONS: Record<PaletteItem['kind'], typeof File> = {
  command: SquareSlash,
  skill: Sparkles,
  file: File,
  dir: Folder,
};

/**
 * The `/` and `@` list above the composer card (cindy's 12px panel). Focus
 * stays in the editor: the editor's keys drive the highlight, and rows keep
 * the caret on mouse down.
 */
export function ComposerPalette({
  palette,
  touch,
  listId,
}: {
  palette: ComposerPaletteState;
  touch: boolean;
  /** The listbox id the editor points to (`aria-controls`). */
  listId: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { items, activeIndex, status, kind } = palette;
  useFitAboveAnchor(panelRef, listRef);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, items]);

  const emptyText =
    status === 'loading'
      ? '正在加载…'
      : status === 'error'
        ? kind === 'slash'
          ? '技能列表加载失败'
          : '无法读取工作区文件'
        : kind === 'slash'
          ? '没有匹配的命令或技能'
          : '没有匹配的文件';

  return (
    <div
      ref={panelRef}
      data-composer-palette={kind}
      className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[12px] border border-surface-border bg-popover text-popover-foreground shadow-menu"
    >
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={kind === 'slash' ? '命令与技能' : '工作区文件'}
        className="overflow-y-auto overscroll-contain p-1"
      >
        {items.map((item, index) => {
          const Icon = ICONS[item.kind];
          const active = index === activeIndex;
          return (
            <div
              key={item.key}
              id={paletteOptionId(listId, index)}
              role="option"
              aria-selected={active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => !active && palette.setActiveIndex(index)}
              onClick={() => palette.pick(index)}
              className={cn(
                'flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-body',
                touch && 'min-h-10',
                active && 'bg-surface-hover',
              )}
            >
              <Icon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="shrink-0 truncate font-medium">
                {item.label}
              </span>
              {item.detail ? (
                <span className="min-w-0 truncate text-caption text-muted-foreground">
                  {item.detail}
                </span>
              ) : null}
            </div>
          );
        })}
        {items.length === 0 || status === 'loading' ? (
          <div className="flex h-8 items-center gap-2 px-2 text-caption text-muted-foreground">
            {status === 'loading' ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : null}
            {items.length === 0 ? emptyText : '正在加载…'}
          </div>
        ) : null}
      </div>
      {!touch && (
        <div className="border-t border-surface-border px-3 py-1.5 text-micro text-faint-foreground">
          {kind === 'slash'
            ? '↑↓ 选择 · Enter 插入 · Esc 关闭'
            : '↑↓ 选择 · Enter 插入 · Tab 进入目录 · Esc 关闭'}
        </div>
      )}
    </div>
  );
}
