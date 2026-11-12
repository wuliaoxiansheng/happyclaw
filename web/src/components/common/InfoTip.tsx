import type { ReactElement, ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Extra information about `children` (the trigger, rendered as is). With a
 * mouse it is a hover tooltip; touch has no hover, so there a tap opens the
 * same content in a popover.
 */
export function InfoTip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const coarse = useMediaQuery('(pointer: coarse)');
  if (coarse) {
    return (
      <Popover>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent side={side} className="w-auto max-w-72 text-caption">
          {content}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}
