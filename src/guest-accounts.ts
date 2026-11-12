/**
 * Who may hold read-only guests, and whether a guest account is usable right
 * now. Kept apart from src/guest-access.ts (the view predicates) because it
 * reads system settings.
 */
import {
  deleteUserSessionsByUserId,
  getUserById,
  listGuestIdsByOwner,
} from './db.js';
import { getSystemSettings } from './runtime-config.js';
import type { User, UserRole } from './types.js';
import { invalidateUserSessions } from './web-context.js';

/** Guests one owner may hold at a time (disabled ones count). */
export const MAX_GUESTS_PER_OWNER = 20;

/**
 * Whether `user` may hold guests: admins always; members only while the
 * `allowMemberGuests` system setting is on (guests skip the invite-only
 * registration, so it is off by default).
 */
export function canOwnGuests(user: { role: UserRole }): boolean {
  if (user.role === 'admin') return true;
  return user.role === 'member' && getSystemSettings().allowMemberGuests;
}

export type GuestAccountState =
  | { valid: true; guest: User; owner: User }
  | { valid: false; reason: 'not_guest' | 'guest_inactive' | 'owner_invalid' };

/**
 * Fresh (uncached) validity of a guest account: the row is an active guest
 * and its owner is active and may hold guests (canOwnGuests). Checked on
 * every guest request so a disabled or deleted owner, or turning
 * `allowMemberGuests` off, cuts the guests off immediately.
 */
export function getGuestAccountState(guestUserId: string): GuestAccountState {
  const guest = getUserById(guestUserId);
  if (!guest || guest.role !== 'guest') {
    return { valid: false, reason: 'not_guest' };
  }
  if (guest.status !== 'active') {
    return { valid: false, reason: 'guest_inactive' };
  }
  const owner = guest.guest_owner_id
    ? getUserById(guest.guest_owner_id)
    : undefined;
  if (!owner || owner.status !== 'active' || !canOwnGuests(owner)) {
    return { valid: false, reason: 'owner_invalid' };
  }
  return { valid: true, guest, owner };
}

/**
 * Log out every guest of `ownerId`. Called when the owner is disabled or
 * deleted; the per-request owner check already denies them, this also drops
 * their sessions so open tabs and sockets do not linger.
 */
export function revokeGuestSessionsForOwner(ownerId: string): number {
  const guestIds = listGuestIdsByOwner(ownerId);
  for (const guestId of guestIds) {
    invalidateUserSessions(guestId);
    deleteUserSessionsByUserId(guestId);
  }
  return guestIds.length;
}
