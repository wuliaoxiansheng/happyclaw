import type { LucideIcon } from 'lucide-react';

import type { MenuAction } from '@/components/common/ResponsiveMenu';

export { ActionSheet } from '@/components/common/ActionSheet';

/** The composer's rows always carry an icon (its dropdown renders it). */
export type SheetAction = MenuAction & { icon: LucideIcon };
