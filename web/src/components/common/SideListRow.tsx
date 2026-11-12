import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A row of a page's side list (自动化, 工作项): a full-width button with a
 * title line and a subtitle line as children, marked current when selected.
 */
export function SideListRow({
  selected,
  onSelect,
  className,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'bg-surface-selected' : 'hover:bg-surface-hover',
        className,
      )}
    >
      {children}
    </button>
  );
}
