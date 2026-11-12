import { create } from 'zustand';

/** How far the reader has got answering one AskUserQuestion card. */
export interface AskProgress {
  /** Options picked, by question. */
  picked: string[][];
  /** The reader's own answer, by question. */
  own: string[];
  /** The question on show. */
  index: number;
}

interface AskAnswersState {
  /**
   * By `toolUseId`. The card is rendered while the reply streams and again
   * once it settles; both read this, so a remount keeps the answers. Kept
   * in memory only (the answer itself is the next message), and bounded:
   * the newest cards are kept.
   */
  progress: Record<string, AskProgress>;
  setProgress: (toolUseId: string, progress: AskProgress) => void;
}

const MAX_CARDS = 200;

export const useAskAnswersStore = create<AskAnswersState>((set) => ({
  progress: {},
  setProgress: (toolUseId, progress) =>
    set((state) => {
      const next = { ...state.progress };
      delete next[toolUseId];
      next[toolUseId] = progress;
      const ids = Object.keys(next);
      if (ids.length > MAX_CARDS) delete next[ids[0]];
      return { progress: next };
    }),
}));
