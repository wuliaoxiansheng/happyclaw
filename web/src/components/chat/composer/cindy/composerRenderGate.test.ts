/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/__tests__/composerRenderGate.test.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6.
 * Dropped: the `$` slash sigil fields and assertions, and the test-only
 * defaults export.
 */
import { describe, expect, it } from 'vitest';

import {
  composerRenderSnapshot,
  shouldRefreshComposerRender,
} from './composerRenderGate';

describe('composer render gate', () => {
  it('skips ordinary text updates when trigger and send state are stable', () => {
    const none = composerRenderSnapshot({ kind: 'none' }, true);
    expect(
      shouldRefreshComposerRender(
        none,
        composerRenderSnapshot({ kind: 'none' }, true),
      ),
    ).toBe(false);
  });

  it('refreshes when text becomes sendable or empty', () => {
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, false),
        composerRenderSnapshot({ kind: 'none' }, true),
      ),
    ).toBe(true);
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true),
        composerRenderSnapshot({ kind: 'none' }, false),
      ),
    ).toBe(true);
  });

  it('refreshes when a palette trigger changes', () => {
    const before = composerRenderSnapshot(
      { kind: 'slash', query: '', from: 1 },
      true,
    );
    expect(
      shouldRefreshComposerRender(
        before,
        composerRenderSnapshot({ kind: 'slash', query: 'he', from: 1 }, true),
      ),
    ).toBe(true);
  });

  it('refreshes when the trigger kind itself changes', () => {
    // 'none' -> a palette trigger opening.
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true),
        composerRenderSnapshot({ kind: 'slash', query: '', from: 1 }, true),
      ),
    ).toBe(true);
    // A palette trigger closing back to 'none'.
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'slash', query: '', from: 1 }, true),
        composerRenderSnapshot({ kind: 'none' }, true),
      ),
    ).toBe(true);
    // One palette trigger kind swapping directly for the other.
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'slash', query: '', from: 1 }, true),
        composerRenderSnapshot({ kind: 'at', query: '', from: 1 }, true),
      ),
    ).toBe(true);
  });
});
