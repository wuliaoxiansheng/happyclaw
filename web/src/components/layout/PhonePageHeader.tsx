import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { ChevronLeft, Ellipsis } from 'lucide-react';
import { create } from 'zustand';

import { cn } from '@/lib/utils';
import { IconButton } from '../common/IconButton';
import { ResponsiveMenu, type MenuAction } from '../common/ResponsiveMenu';
import { NavDrawerButton } from './NavDrawer';
import { useIsPhone } from './phone';

export interface PhonePageHeaderProps {
  title: ReactNode;
  /** Shows a back button in place of the menu button. */
  onBack?: () => void;
  /** At most one primary action, e.g. a "new" button. */
  action?: ReactNode;
  /** Secondary actions, behind ⋯ in a bottom sheet. */
  menu?: { title: string; groups: MenuAction[][] };
}

/** A 44px round icon button sized for the phone top bar. */
export function PhoneBarButton(
  props: Omit<ComponentProps<typeof IconButton>, 'size' | 'hideTooltip'>,
) {
  return (
    <IconButton
      {...props}
      size="icon"
      hideTooltip
      className={cn('size-11 rounded-full text-foreground', props.className)}
    />
  );
}

const usePhoneHeaderStore = create<{
  header: PhonePageHeaderProps | null;
}>(() => ({ header: null }));

/**
 * Names the page in the phone's single top bar (cindy's SimpleStackHeader):
 * menu or back, title, one action and ⋯. It renders nothing where it is
 * placed; AppLayout draws the bar, so a page that never declares one keeps
 * a bar with only the menu button. Desktop pages keep their own headers.
 */
export function PhonePageHeader(props: PhonePageHeaderProps) {
  const isPhone = useIsPhone();
  useEffect(() => {
    if (!isPhone) return;
    usePhoneHeaderStore.setState({ header: props });
  });
  useEffect(
    () => () => {
      usePhoneHeaderStore.setState({ header: null });
    },
    [],
  );
  return null;
}

/** The bar AppLayout renders on phones above every non-chat page. */
export function PhoneTopBar() {
  const header = usePhoneHeaderStore((s) => s.header);
  const groups = header?.menu?.groups.filter((group) => group.length > 0);
  return (
    <div
      data-testid="phone-top-bar"
      className="flex h-13 shrink-0 items-center gap-1 px-2"
    >
      {header?.onBack ? (
        <PhoneBarButton
          label="返回"
          icon={<ChevronLeft className="size-6" />}
          onClick={header.onBack}
        />
      ) : (
        <NavDrawerButton />
      )}
      {header && (
        <>
          <h1 className="min-w-0 flex-1 truncate text-title-sm text-foreground">
            {header.title}
          </h1>
          {header.action}
          {header.menu && groups && groups.length > 0 && (
            <ResponsiveMenu
              title={header.menu.title}
              groups={groups}
              trigger={
                <PhoneBarButton
                  label="更多操作"
                  icon={<Ellipsis className="size-5" />}
                />
              }
            />
          )}
        </>
      )}
    </div>
  );
}
