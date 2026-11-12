import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

/**
 * What the phone dock tells the controls it hosts (the model picker comes in
 * from ChatView as an element, so this goes by context, not props).
 */
export interface ComposerDockApi {
  /** The resting phone pill: a control shows its compact form. */
  compact: boolean;
  /**
   * A sheet or menu a dock control owns opened or closed. Call it from the
   * open-change handler, not an effect: the card must already count it as
   * open when focus moves into the overlay (cindy's composerCardActive).
   */
  setOverlayOpen: (id: string, open: boolean) => void;
}

export const ComposerDockContext = createContext<ComposerDockApi | null>(null);

/** The composer around this control; null outside one. */
export function useComposerDock(): ComposerDockApi | null {
  return useContext(ComposerDockContext);
}

/**
 * The open state of one overlay a dock control owns, reported to the
 * composer around it as it changes. An overlay unmounted while open counts
 * as closed. Each instance reports under its own id, so one closing or
 * unmounting (a remount overlapping its successor) never clears another's.
 */
export function useDockOverlay(): [
  open: boolean,
  setOpen: (open: boolean) => void,
] {
  const id = useId();
  const [open, setOpenState] = useState(false);
  const dock = useComposerDock();
  const dockRef = useRef(dock);
  dockRef.current = dock;
  useEffect(() => () => dockRef.current?.setOverlayOpen(id, false), [id]);
  const setOpen = useCallback(
    (next: boolean) => {
      dockRef.current?.setOverlayOpen(id, next);
      setOpenState(next);
    },
    [id],
  );
  return [open, setOpen];
}
