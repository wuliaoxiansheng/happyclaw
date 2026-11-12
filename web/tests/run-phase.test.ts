import { describe, expect, it } from 'vitest';
import {
  DEEP_THINKING_STATUS,
  describeRunPhase,
  runPhaseKind,
} from '../src/lib/run-phase';
import type { StreamingState } from '../src/stores/chat';

const state = (over: Partial<StreamingState> = {}): StreamingState => ({
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
  ...over,
});

const tool = (toolName: string, isNested = false) => ({
  toolName,
  toolUseId: toolName,
  startTime: 0,
  isNested,
});

describe('runPhaseKind', () => {
  it('names what the run is doing, in the order the status line weighs it', () => {
    expect(runPhaseKind(state(), true)).toBe('stopping');
    expect(runPhaseKind(undefined, false)).toBe('preparing');
    expect(runPhaseKind(state({ settling: true }), false)).toBe('preparing');
    expect(
      runPhaseKind(
        state({ partialText: '答', activeTools: [tool('Bash')] }),
        false,
      ),
    ).toBe('tool');
    expect(runPhaseKind(state({ systemStatus: 'compacting' }), false)).toBe(
      'compacting',
    );
    expect(
      runPhaseKind(state({ partialText: '答', awaitingModel: true }), false),
    ).toBe('thinking');
    expect(
      runPhaseKind(state({ systemStatus: DEEP_THINKING_STATUS }), false),
    ).toBe('deep-thinking');
    expect(runPhaseKind(state({ partialText: '答' }), false)).toBe('replying');
    expect(
      runPhaseKind(
        state({ activeHook: { hookName: 'h', hookEvent: 'e' } }),
        false,
      ),
    ).toBe('hook');
    expect(runPhaseKind(state(), false)).toBe('thinking');
  });
});

describe('describeRunPhase', () => {
  it('words each kind of phase', () => {
    expect(describeRunPhase(state(), true)).toBe('正在停止…');
    expect(describeRunPhase(state({ systemStatus: 'compacting' }), false)).toBe(
      '正在整理上下文',
    );
    expect(
      describeRunPhase(state({ systemStatus: DEEP_THINKING_STATUS }), false),
    ).toBe('正在深入分析');
  });

  it("names the run's own latest tool over a sub-agent's", () => {
    const own = describeRunPhase(state({ activeTools: [tool('Bash')] }), false);
    expect(
      describeRunPhase(
        state({ activeTools: [tool('Bash'), tool('Read', true)] }),
        false,
      ),
    ).toBe(own);
    expect(
      describeRunPhase(state({ activeTools: [tool('Read', true)] }), false),
    ).toBe(describeRunPhase(state({ activeTools: [tool('Read')] }), false));
  });
});
