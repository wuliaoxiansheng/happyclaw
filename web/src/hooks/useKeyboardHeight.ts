import { useKeyboardInset } from './useVisualViewport';

/** Keyboard occlusion from the shared visual-viewport store. */
export function useKeyboardHeight() {
  const keyboardHeight = useKeyboardInset();
  return { keyboardHeight, isKeyboardVisible: keyboardHeight > 0 };
}
