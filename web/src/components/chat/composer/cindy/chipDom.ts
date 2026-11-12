/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/MentionChipNode.tsx
 * and components/chat/InlineReferenceChip.tsx (commit 7be4c57d7b, Apache-2.0;
 * see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. The pill geometry of cindy's InlineReferenceChip and its
 * Lucide path fallback, as a ProseMirror DOM spec on HappyClaw tokens.
 */
import type { DOMOutputSpec } from '@tiptap/pm/model';

/** 12px reference pill shared by every composer atom. */
export const COMPOSER_CHIP_CLASS =
  'composer-chip inline-flex min-w-0 max-w-[min(240px,55vw)] cursor-default select-none ' +
  'items-center gap-1.5 rounded-full border border-surface-border bg-muted px-2 align-middle ' +
  'text-caption leading-5 text-foreground';

/** A 14px Lucide icon from its path data. */
export function chipIcon(paths: readonly string[]): DOMOutputSpec {
  return [
    'http://www.w3.org/2000/svg svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width: '14',
      height: '14',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: 'shrink-0 text-muted-foreground',
    },
    ...paths.map((d) => ['path', { d }] as DOMOutputSpec),
  ];
}
