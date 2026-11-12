import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

/**
 * What a phone opens from the conversation to read in full (a tool's output,
 * a message's text, a workspace file): a bottom sheet with a title, and its
 * body as the one scroller. Mounted while open.
 */
export function DetailSheet({
  title,
  onClose,
  action,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Beside the title: a download, say. */
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className={cn('[--md-table-bg:var(--surface-raised)]', className)}
      >
        <SheetHeader
          className={cn('pb-2', action && 'flex-row items-center gap-2')}
        >
          <SheetTitle className={cn(action && 'min-w-0 flex-1 truncate')}>
            {title}
          </SheetTitle>
          {action}
        </SheetHeader>
        <SheetBody className={cn('px-4 pb-4', bodyClassName)}>
          {children}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
