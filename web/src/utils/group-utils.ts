import type { GroupInfo } from '../types';

export type GroupEntry = GroupInfo & { jid: string };

/** Sort comparator: newest activity first. */
export function compareByLastActivity(a: GroupEntry, b: GroupEntry): number {
  return (
    new Date(b.lastMessageTime || b.added_at).getTime() -
    new Date(a.lastMessageTime || a.added_at).getTime()
  );
}

/** Sidebar order: the user's home workspace, then pinned ones, then newest activity. */
export function compareWorkspaces(a: GroupEntry, b: GroupEntry): number {
  if (!!a.is_my_home !== !!b.is_my_home) return a.is_my_home ? -1 : 1;
  return (
    Number(!!b.pinned_at) - Number(!!a.pinned_at) || compareByLastActivity(a, b)
  );
}
