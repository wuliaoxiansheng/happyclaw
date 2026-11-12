/**
 * The reader's open-or-closed choice of a reply's process card, by the turn it
 * belongs to. The live card and the finished reply that takes its place are
 * separate elements, so the choice is kept here to survive the swap (and a
 * remount), like cindy's expanded-block memory. In memory for the visit only,
 * and bounded: the newest choices are kept.
 */
const MAX_CHOICES = 200;
const choices = new Map<string, boolean>();

export function rememberProcessOpen(
  turnId: string | null | undefined,
  open: boolean,
): void {
  if (!turnId) return;
  choices.delete(turnId);
  choices.set(turnId, open);
  if (choices.size > MAX_CHOICES) {
    choices.delete(choices.keys().next().value!);
  }
}

/** The choice made for the card of `turnId`, if the reader made one. */
export function rememberedProcessOpen(
  turnId: string | null | undefined,
): boolean | undefined {
  return turnId ? choices.get(turnId) : undefined;
}

/** Forget every choice: a fresh visit (and a test's own). */
export function forgetProcessOpenChoices(): void {
  choices.clear();
}
