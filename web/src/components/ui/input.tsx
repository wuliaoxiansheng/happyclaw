import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Typing props for identifiers, keys, URLs and paths: no auto-capitalised
 * first letter, autocorrect or spellcheck on phone keyboards. Spread before
 * the caller's props so they can still override each one.
 */
const codeInputProps = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

type TextFieldVariant = 'default' | 'code';

// On a phone the field is 16px, the size below which iOS zooms in on focus,
// and 44px tall; `phone:` comes after `md:` so it also wins on iPad portrait.
function Input({
  className,
  type,
  variant = 'default',
  ...props
}: React.ComponentProps<'input'> & { variant?: TextFieldVariant }) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      {...(variant === 'code' ? codeInputProps : undefined)}
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 phone:h-11 phone:text-base',
        className,
      )}
      {...props}
    />
  );
}

export { Input, codeInputProps, type TextFieldVariant };
