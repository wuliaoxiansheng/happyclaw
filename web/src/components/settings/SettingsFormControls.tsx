import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SettingsRow, type SettingsRowProps } from './SettingsLayout';

/**
 * Shared save placement for settings forms: the primary action sits
 * right-aligned directly below the last group it saves, at the default
 * 32px button size.
 */
export function SettingsFormFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-form-footer"
      className={cn('flex flex-wrap items-center justify-end gap-2', className)}
    >
      {children}
    </div>
  );
}

/**
 * Save footer for long multi-field forms. It sticks to the bottom of the app
 * scroll root and stays opaque. Below the desktop layout it extends down
 * to the bottom edge so nothing scrolls through between it and the bottom
 * navigation: the offsets cancel `pb-nav-safe` (`--nav-clearance`) and the
 * padding covers the floating BottomTabBar of narrow windows, or only the
 * home indicator on phones (`--nav-cover`, both in globals.css).
 */
export function SettingsStickySaveBar({
  status,
  children,
}: {
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="settings-sticky-save-bar"
      className="sticky bottom-0 z-10 mt-8 -mx-4 border-t border-surface-border bg-background px-4 max-lg:-bottom-(--nav-clearance) max-lg:-mb-(--nav-clearance) max-lg:pb-(--nav-cover) sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
    >
      <div className="flex h-14 items-center justify-between gap-4">
        <div className="min-w-0">{status}</div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * SettingsRow for a Switch: keeps the control on the right on narrow
 * screens instead of stacking it under the description.
 */
export function SettingsSwitchRow(props: SettingsRowProps) {
  return <SettingsRow {...props} inline />;
}
