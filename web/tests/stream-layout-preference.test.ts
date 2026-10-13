import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STREAM_LAYOUT,
  readStreamLayout,
} from '../src/hooks/useStreamLayout';

describe('the stream layout preference', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the step timeline unless the reader chose the classic layout', () => {
    expect(DEFAULT_STREAM_LAYOUT).toBe('timeline');
    expect(readStreamLayout('happyclaw-stream-layout:u1')).toBe('timeline');
    store.set('happyclaw-stream-layout:u1', 'classic');
    expect(readStreamLayout('happyclaw-stream-layout:u1')).toBe('classic');
    // Another user in this browser keeps their own choice.
    expect(readStreamLayout('happyclaw-stream-layout:u2')).toBe('timeline');
  });

  it('ignores a stored value it does not know', () => {
    store.set('happyclaw-stream-layout:u1', 'sideways');
    expect(readStreamLayout('happyclaw-stream-layout:u1')).toBe('timeline');
  });

  it('falls back when storage cannot be read', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(readStreamLayout('happyclaw-stream-layout:u1')).toBe('timeline');
  });
});
