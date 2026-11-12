import * as React from 'react';

import { codeInputProps, type TextFieldVariant } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// 16px on a phone like Input, so focusing it never zooms the page.
function Textarea({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'textarea'> & { variant?: TextFieldVariant }) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      {...(variant === 'code' ? codeInputProps : undefined)}
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 phone:text-base',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
