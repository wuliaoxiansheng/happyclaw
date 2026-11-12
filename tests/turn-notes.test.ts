import { describe, expect, test } from 'vitest';

import { resolveAgentTurnAnchor } from '../container/agent-runner/src/agent-turn-contract.js';
import type {
  HappyClawOwnerProfileTurnResult,
  WorkspaceMemorySnapshot,
} from '../container/agent-runner/src/mcp-tools.js';
import { HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK } from '../container/agent-runner/src/owner-profile-context.js';
import {
  decorateUserTurn,
  TurnNoteLedger,
  type TurnNoteSources,
} from '../container/agent-runner/src/turn-notes.js';
import type { ChannelTurnContext } from '../container/agent-runner/src/types.js';

function memory(
  ...items: Array<{ id: string; revision?: number; content?: string }>
): WorkspaceMemorySnapshot {
  const full = items.map((item) => ({
    id: item.id,
    revision: item.revision ?? 1,
    kind: 'fact',
    content: item.content ?? `content of ${item.id}`,
  }));
  return {
    workspaceJid: 'web:ws',
    storeRevision: 7,
    items: full,
    renderedText: [
      '<workspace_memory workspace="web:ws" revision="7">',
      ...full.map(
        (item) =>
          `<memory id="${item.id}" revision="${item.revision}" kind="fact">${item.content}</memory>`,
      ),
      '</workspace_memory>',
    ].join('\n'),
    retrievalTrace: {
      itemRevisions: full.map(({ id, revision }) => ({ id, revision })),
      generatedAt: '2026-10-28T00:00:00.000Z',
    },
  };
}

function owner(
  preferredAddress: string,
  revision = 1,
): HappyClawOwnerProfileTurnResult {
  return {
    projection: {
      workspaceJid: 'web:home',
      preferredAddress,
      revision,
      onboarding: {
        state: 'completed',
        revision: 2,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    },
    onboardingStatus: 'known',
    firstWake: false,
  };
}

function channel(
  messageId: string,
  extra: Partial<ChannelTurnContext> = {},
): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    sourceJid: 'feishu:oc_chat',
    channelAccountId: 'account-1',
    chat: { id: 'oc_chat', type: 'group' },
    message: { id: messageId },
    sender: { openId: 'ou_a' },
    ...extra,
  };
}

const anchor = resolveAgentTurnAnchor(
  {
    id: 'agent',
    name: 'Agent',
    version: 1,
    identityHash: 'hash',
    identityPrompt: 'Follow the release contract.',
  },
  'custom',
);

const sources = (over: Partial<TurnNoteSources> = {}): TurnNoteSources => ({
  memory: memory({ id: 'a' }, { id: 'b' }),
  ownerProfile: owner('小何'),
  channelContext: channel('om_1'),
  anchor,
  ...over,
});

/** Stage one turn and answer it in a healthy result. */
function turn(
  ledger: TurnNoteLedger,
  uuid: string,
  input: TurnNoteSources,
  resumeAnchor?: string,
) {
  const notes = ledger.stage(uuid, input);
  ledger.observeAnswered([uuid]);
  ledger.commitAnswered(resumeAnchor);
  return notes;
}

describe('per-turn notes', () => {
  test('a later turn carries only what changed, and nothing when nothing did', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const first = turn(ledger, 'u1', sources());
    ledger.bindSession('s1');
    expect(first.ownerProfile).toContain('小何');
    expect(first.memory).toContain('content of a');
    expect(first.channel).toContain('"om_1"');
    expect(first.anchor).toBe(anchor);
    expect(first.sentMemory).toEqual([
      { id: 'a', revision: 1 },
      { id: 'b', revision: 1 },
    ]);

    const same = turn(
      ledger,
      'u2',
      sources({ channelContext: channel('om_1') }),
    );
    expect(same).toMatchObject({
      ownerProfile: '',
      memory: '',
      channel: '',
      anchor: undefined,
      sentMemory: [],
    });
    expect(decorateUserTurn('hello', same)).toBe('hello');

    const changed = turn(
      ledger,
      'u3',
      sources({
        memory: memory(
          { id: 'a', revision: 2, content: 'edited a' },
          { id: 'c' },
        ),
        ownerProfile: owner('何先生', 2),
        channelContext: channel('om_3'),
      }),
    );
    expect(changed.sentMemory).toEqual([
      { id: 'a', revision: 2 },
      { id: 'c', revision: 1 },
    ]);
    expect(changed.memory).toContain('edited a');
    expect(changed.memory).not.toContain('content of b');
    expect(changed.ownerProfile).toContain('何先生');
    expect(changed.channel).toContain('changes_only="true"');
    expect(changed.channel).toContain('{"message":{"id":"om_3"}}');
  });

  test("a channel's format guidance comes with its context, once per channel", () => {
    const FEISHU = '## 飞书消息格式';
    const TELEGRAM = '## Telegram 消息格式';
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const feishu = (id: string) =>
      sources({ channelContext: channel(id), channelFormat: FEISHU });
    const first = turn(ledger, 'u1', feishu('om_1')).channel;
    expect(first).toContain(`<channel_format provider="feishu">\n${FEISHU}`);
    expect(first.indexOf('<channel_format')).toBeLessThan(
      first.indexOf('</channel_context>'),
    );
    expect(turn(ledger, 'u2', feishu('om_2')).channel).not.toContain(
      '<channel_format',
    );

    // Another channel's input, piped into the same warm runner.
    const telegram = turn(
      ledger,
      'u3',
      sources({
        channelContext: channel('tg_3', {
          provider: 'telegram',
          sourceJid: 'telegram:chat',
        }),
        channelFormat: TELEGRAM,
      }),
    ).channel;
    expect(telegram).toContain('changes_only="true"');
    expect(telegram).toContain(
      `<channel_format provider="telegram">\n${TELEGRAM}`,
    );

    // The Web has no rules of its own: the earlier ones are withdrawn.
    const web = turn(
      ledger,
      'u4',
      sources({
        channelContext: {
          schemaVersion: 1,
          provider: 'web',
          sourceJid: 'web:ws',
        },
      }),
    ).channel;
    expect(web).toContain('<channel_format provider="web">');
    expect(web).toContain('no longer applies');
    // A Web-only session never gets a format block.
    const webOnly = new TurnNoteLedger();
    webOnly.beginQuery(undefined);
    expect(
      turn(webOnly, 'v1', sources({ channelContext: channel('om_1') })).channel,
    ).not.toContain('<channel_format');
  });

  test('a dropped channel field is sent as null', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(
      ledger,
      'u1',
      sources({
        channelContext: channel('om_1', { mentions: [{ name: 'Bot' }] }),
      }),
    );
    const next = turn(
      ledger,
      'u2',
      sources({ channelContext: channel('om_1') }),
    );
    expect(next.channel).toContain('{"mentions":null}');
  });

  test("a turn without the owner's block withdraws the one in context", () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    const stranger = turn(ledger, 'u2', sources({ ownerProfile: null }));
    expect(stranger.ownerProfile).toBe(HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK);
    expect(
      turn(ledger, 'u3', sources({ ownerProfile: null })).ownerProfile,
    ).toBe('');
    expect(turn(ledger, 'u4', sources()).ownerProfile).toContain('小何');
    // A session that never had a block withdraws nothing.
    const fresh = new TurnNoteLedger();
    fresh.beginQuery(undefined);
    expect(
      turn(fresh, 'v1', sources({ ownerProfile: null })).ownerProfile,
    ).toBe('');
  });

  test('the anchor rides on every tenth turn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const anchored = Array.from({ length: 21 }, (_, i) =>
      turn(ledger, `u${i}`, sources()).anchor ? i + 1 : 0,
    ).filter(Boolean);
    expect(anchored).toEqual([1, 11, 21]);
    // A turn that may not carry it (a continuation) does not count.
    const quiet = new TurnNoteLedger();
    quiet.beginQuery(undefined);
    turn(quiet, 'q0', sources());
    for (let i = 1; i <= 20; i++)
      turn(quiet, `q${i}`, sources({ anchor: undefined }));
    expect(turn(quiet, 'q21', sources()).anchor).toBeUndefined();
  });

  test('notes count only once a healthy result answered their turn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    ledger.stage('u1', sources());
    ledger.bindSession('s1');
    // The turn failed: the next query sends everything again.
    ledger.beginQuery('s1', 'assistant-1');
    expect(ledger.stage('u2', sources()).anchor).toBe(anchor);

    // Answered but not completed (background work pending): not yet sent.
    ledger.observeAnswered(['u2']);
    ledger.beginQuery('s1', 'assistant-2');
    const again = ledger.stage('u3', sources());
    expect(again.memory).toContain('content of a');
    ledger.observeAnswered(['u3']);
    ledger.commitAnswered('assistant-3');
    expect(ledger.stage('u4', sources()).memory).toBe('');
  });

  test('a queued turn plans against the turns ahead of it, merged or not', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    ledger.stage('u1', sources());
    const queued = ledger.stage('u2', sources());
    expect(queued.memory).toBe('');
    // One result answered both (the CLI merged them).
    ledger.observeAnswered(['u1', 'u2']);
    ledger.commitAnswered('assistant-2');
    expect(ledger.stage('u3', sources()).channel).toBe('');

    // A result answers the turn ahead; the queued one is not in yet.
    const split = new TurnNoteLedger();
    split.beginQuery(undefined);
    split.stage('v1', sources());
    split.bindSession('s1');
    split.stage('v2', sources({ memory: memory({ id: 'c' }) }));
    split.observeAnswered(['v1']);
    split.commitAnswered('assistant-v1');
    split.beginQuery('s1'); // v2 was interrupted
    expect(
      split.stage('v3', sources({ memory: memory({ id: 'c' }) })).sentMemory,
    ).toEqual([{ id: 'c', revision: 1 }]);
  });

  test('a retry that resumes at the last healthy turn forgets what came after it', () => {
    // A healthy turn without an assistant uuid does not move the resume point.
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources(), 'assistant-1');
    ledger.bindSession('s1');
    turn(ledger, 'u2', sources({ memory: memory({ id: 'a' }, { id: 'c' }) }));
    ledger.beginQuery('s1', 'assistant-1');
    const retried = ledger.stage(
      'u3',
      sources({ memory: memory({ id: 'c' }) }),
    );
    expect(retried.sentMemory).toEqual([{ id: 'c', revision: 1 }]);
    expect(retried.anchor).toBeUndefined();

    // A compaction during the failed turn: the retry resumes before it.
    const compacted = new TurnNoteLedger();
    compacted.beginQuery(undefined);
    turn(compacted, 'v1', sources(), 'assistant-v1');
    compacted.bindSession('s2');
    compacted.stage('v2', sources({ channelContext: channel('om_2') }));
    compacted.beginCompaction();
    compacted.restoreAfterCompaction();
    compacted.endCompaction();
    compacted.beginQuery('s2', 'assistant-v1');
    const again = compacted.stage(
      'v2-retry',
      sources({ channelContext: channel('om_2') }),
    );
    expect(again.channel).toContain('{"message":{"id":"om_2"}}');
    expect(again.anchor).toBeUndefined();
  });

  test('another session, or a new one, starts over', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    ledger.bindSession('s1');
    ledger.beginQuery('s1');
    expect(ledger.stage('u2', sources()).anchor).toBeUndefined();

    ledger.beginQuery('s2'); // /clear, a provider switch that cleared it
    expect(ledger.stage('u3', sources()).anchor).toBe(anchor);
    ledger.beginQuery(undefined); // /fresh
    expect(ledger.stage('u4', sources()).anchor).toBe(anchor);

    // The CLI answered with another session than the one resumed.
    const other = new TurnNoteLedger();
    other.beginQuery(undefined);
    turn(other, 'v1', sources());
    other.bindSession('s1');
    other.beginQuery('s1');
    other.bindSession('s9');
    expect(other.stage('v2', sources()).anchor).toBe(anchor);
  });

  test('a compaction restores the latest notes in full, once', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    ledger.bindSession('s1');
    // Turn 2 is in flight, carrying only its new channel message.
    ledger.stage(
      'u2',
      sources({
        channelContext: channel('om_2'),
        channelFormat: '## 飞书消息格式',
        anchor: undefined,
      }),
    );
    ledger.beginCompaction();
    const restored = ledger.restoreAfterCompaction();
    ledger.endCompaction();
    expect(restored).toContain('<active-agent-turn-contract');
    expect(restored).toContain('小何');
    expect(restored).toContain('content of b');
    expect(restored).toContain('"om_2"');
    expect(restored).toContain('<channel_format provider="feishu">');
    expect(restored).not.toContain('changes_only');
    // The restored notes are in the context: the next turn adds nothing.
    const next = ledger.stage(
      'u3',
      sources({
        channelContext: channel('om_2'),
        channelFormat: '## 飞书消息格式',
      }),
    );
    expect([next.memory, next.channel, next.ownerProfile]).toEqual([
      '',
      '',
      '',
    ]);
    expect(next.anchor).toBeUndefined();
  });

  test('a compaction without a restore sends everything on the next turn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    ledger.beginCompaction();
    ledger.endCompaction();
    const next = ledger.stage('u2', sources());
    expect(next.anchor).toBe(anchor);
    expect(next.memory).toContain('content of a');
  });

  test('decorated turns keep the platform order inside the anchor', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const text = decorateUserTurn(
      'the question',
      ledger.stage('u1', sources()),
    );
    const at = (needle: string) => text.indexOf(needle);
    expect(at('<active-agent-turn-contract')).toBe(0);
    expect(at('<workspace_owner_profile')).toBeLessThan(
      at('<workspace_memory_snapshot'),
    );
    expect(at('<workspace_memory_snapshot')).toBeLessThan(
      at('<channel_context'),
    );
    expect(text).toMatch(
      /<channel_context[\s\S]*\n\nthe question\n<\/current-user-message>$/,
    );
  });
});

/** A snapshot that also reports items changed since the revision asked. */
function withChanges(
  snapshot: WorkspaceMemorySnapshot,
  items: Array<{ id: string; revision: number; status: string }>,
  reset = false,
): WorkspaceMemorySnapshot {
  return { ...snapshot, storeRevision: 9, changes: { reset, items } };
}

const memoryJson = (block: string) =>
  JSON.parse(
    block
      .split('\n')[1]
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\\u0026/g, '&'),
  );

describe('withdrawals and restores', () => {
  test('a forgotten memory is withdrawn, once', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    expect(ledger.memoryHeld()).toEqual({});
    turn(ledger, 'u1', sources({ memory: memory({ id: 'a' }, { id: 'b' }) }));
    expect(ledger.memoryHeld()).toEqual({
      changedSince: 7,
      heldIds: ['a', 'b'],
    });
    const next = turn(
      ledger,
      'u2',
      sources({
        memory: withChanges(memory({ id: 'b' }), [
          { id: 'a', revision: 2, status: 'deleted' },
        ]),
      }),
    );
    expect(next.withdrawnMemory).toEqual([{ id: 'a', status: 'deleted' }]);
    expect(memoryJson(next.memory)).toMatchObject({
      items: [],
      withdrawn: [{ id: 'a', status: 'deleted' }],
    });
    expect(next.memory).toContain('withdraws or replaces');
    expect(ledger.memoryHeld()).toEqual({ changedSince: 9, heldIds: ['b'] });
    // Reported again (the host lists changes since the revision asked): no repeat.
    const again = turn(
      ledger,
      'u3',
      sources({
        memory: withChanges(memory({ id: 'b' }), [
          { id: 'a', revision: 2, status: 'deleted' },
        ]),
      }),
    );
    expect(again.memory).toBe('');
  });

  test('a revised memory is replaced when recalled, withdrawn when not', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources({ memory: memory({ id: 'a' }, { id: 'b' }) }));
    const notRecalled = turn(
      ledger,
      'u2',
      sources({
        memory: withChanges(memory({ id: 'b' }), [
          { id: 'a', revision: 2, status: 'active' },
          { id: 'b', revision: 1, status: 'active' },
        ]),
      }),
    );
    expect(notRecalled.withdrawnMemory).toEqual([
      { id: 'a', status: 'revised' },
    ]);
    // Recalled later, the new revision comes as a new memory.
    const recalled = turn(
      ledger,
      'u3',
      sources({
        memory: withChanges(
          memory({ id: 'a', revision: 2, content: 'new a' }),
          [{ id: 'a', revision: 2, status: 'active' }],
        ),
      }),
    );
    expect(recalled.sentMemory).toEqual([{ id: 'a', revision: 2 }]);
    expect(recalled.withdrawnMemory).toEqual([]);

    const other = new TurnNoteLedger();
    other.beginQuery(undefined);
    turn(other, 'v1', sources({ memory: memory({ id: 'a' }) }));
    const replaced = turn(
      other,
      'v2',
      sources({
        memory: withChanges(
          memory({ id: 'a', revision: 2, content: 'new a' }),
          [{ id: 'a', revision: 2, status: 'active' }],
        ),
      }),
    );
    expect(replaced.sentMemory).toEqual([{ id: 'a', revision: 2 }]);
    expect(replaced.withdrawnMemory).toEqual([]);
  });

  test('a replaced store (or too many changes) withdraws what is held and resends the snapshot whole', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources({ memory: memory({ id: 'a' }, { id: 'b' }) }));
    const next = turn(
      ledger,
      'u2',
      sources({
        memory: withChanges(memory({ id: 'a' }, { id: 'c' }), [], true),
      }),
    );
    expect(next.withdrawnMemory).toEqual([{ id: 'b', status: 'deleted' }]);
    expect(next.sentMemory).toEqual([
      { id: 'a', revision: 1 },
      { id: 'c', revision: 1 },
    ]);
    expect(ledger.memoryHeld().heldIds).toEqual(['a', 'c']);
  });

  test('an expired memory is withdrawn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources({ memory: memory({ id: 'a' }, { id: 'b' }) }));
    const next = turn(
      ledger,
      'u2',
      sources({
        memory: withChanges(memory({ id: 'b' }), [
          { id: 'a', revision: 1, status: 'expired' },
        ]),
      }),
    );
    expect(next.withdrawnMemory).toEqual([{ id: 'a', status: 'expired' }]);
    expect(ledger.memoryHeld().heldIds).toEqual(['b']);
  });

  test("a compaction restores the continued turn's notes, not a queued one's", () => {
    const stranger = (id: string) =>
      sources({
        ownerProfile: null,
        channelContext: channel(id, { sender: { openId: 'ou_stranger' } }),
      });
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    ledger.bindSession('s1');
    turn(ledger, 'u0', sources());
    ledger.stage('uN', stranger('om_N')); // the non-owner turn in flight
    ledger.stage(
      'uN1',
      sources({
        channelContext: channel('om_N1', { sender: { openId: 'ou_owner' } }),
      }),
    );
    ledger.beginCompaction();
    const restored = ledger.restoreAfterCompaction();
    ledger.endCompaction();
    expect(restored).toContain('"om_N"');
    expect(restored).toContain('ou_stranger');
    expect(restored).not.toContain('ou_owner');
    expect(restored).not.toContain('小何');
    // The summary may still name the owner: the restore withdraws the block.
    expect(restored).toContain(HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK);
    // The owner's next turn brings the block back.
    expect(ledger.stage('u2', sources()).ownerProfile).toContain('小何');
  });

  test('a compaction cut short sends everything on the next query', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    ledger.bindSession('s1');
    turn(ledger, 'u1', sources());
    ledger.stage('u2', sources({ channelContext: channel('om_2') }));
    ledger.beginCompaction(); // the query was interrupted before the hooks after it
    ledger.beginQuery('s1');
    const next = ledger.stage(
      'u3',
      sources({ channelContext: channel('om_3') }),
    );
    expect(next.ownerProfile).toContain('小何');
    expect(next.channel).not.toContain('changes_only');
    expect(next.anchor).toBe(anchor);
  });

  test("a prompt run in another session than planned carries that turn's notes in full", () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'v1', sources());
    ledger.bindSession('s1');
    ledger.beginQuery('s1', 'assistant-1');
    const first = ledger.stage(
      'v2',
      sources({ channelContext: channel('om_2') }),
    );
    expect(first.ownerProfile).toBe(''); // planned against s1's context
    expect(ledger.restoreOnSessionChange('s1')).toBe('');
    const restored = ledger.restoreOnSessionChange('s-new');
    expect(restored).toContain('<active-agent-turn-contract');
    expect(restored).toContain('小何');
    expect(restored).toContain('content of a');
    expect(restored).toContain('"om_2"');
    expect(restored).not.toContain('changes_only');
    ledger.bindSession('s-new'); // system/init then names the same session
    const next = ledger.stage(
      'v3',
      sources({ channelContext: channel('om_2') }),
    );
    expect([next.ownerProfile, next.memory, next.channel]).toEqual([
      '',
      '',
      '',
    ]);
    // A fresh session's first prompt was planned against nothing: no restore.
    const fresh = new TurnNoteLedger();
    fresh.beginQuery(undefined);
    fresh.stage('w1', sources());
    expect(fresh.restoreOnSessionChange('s-fresh')).toBe('');
  });

  test("an IM channel's format rides again every tenth turn, and says it persists", () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const withFormat = Array.from({ length: 21 }, (_, i) =>
      turn(
        ledger,
        `u${i}`,
        sources({
          channelContext: channel(`om_${i}`),
          channelFormat: '## 飞书消息格式',
        }),
      ).channel.includes('<channel_format')
        ? i + 1
        : 0,
    ).filter(Boolean);
    expect(withFormat).toEqual([1, 11, 21]);
    const block = turn(
      new TurnNoteLedger(),
      'v1',
      sources({
        channelContext: channel('om_1'),
        channelFormat: '## 飞书消息格式',
      }),
    ).channel;
    expect(block).toContain('The channel_format holds for later inputs too');
    expect(block).toContain('Use the fields for the current input only');
  });
});

describe('the memory index', () => {
  const indexed = (
    entries: Array<[string, string]>,
    total = entries.length,
  ): WorkspaceMemorySnapshot => ({
    ...memory(),
    directory: {
      entries: entries.map(([id, title]) => ({ id, kind: 'fact', title })),
      total,
    },
  });
  const withIndex = (snapshot: WorkspaceMemorySnapshot | null) =>
    sources({
      memory: snapshot,
      ownerProfile: null,
      channelContext: undefined,
    });
  const ab = (): Array<[string, string]> => [
    ['wmi_a', 'Deploy <process>'],
    ['wmi_b', 'Release day'],
  ];

  test('the first turn lists it whole; later turns only what changed', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const first = turn(ledger, 'u1', withIndex(indexed(ab(), 5)));
    expect(first.memoryIndex).toBe(
      [
        '<workspace_memory_index trust="historical_data" instruction_priority="none">',
        'wmi_a · fact · Deploy &lt;process&gt;',
        'wmi_b · fact · Release day',
        '3 more not listed; workspace_memory_search finds them.',
        '</workspace_memory_index>',
      ].join('\n'),
    );
    expect(turn(ledger, 'u2', withIndex(indexed(ab(), 5))).memoryIndex).toBe(
      '',
    );
    // A snapshot without an index, or none at all, keeps what is held.
    expect(turn(ledger, 'u3', withIndex(memory())).memoryIndex).toBe('');
    expect(turn(ledger, 'u4', withIndex(null)).memoryIndex).toBe('');

    const changed = turn(
      ledger,
      'u5',
      withIndex(
        indexed([
          ['wmi_a', 'Deploy process, revised'],
          ['wmi_c', 'New lesson'],
        ]),
      ),
    );
    expect(changed.memoryIndex).toBe(
      [
        '<workspace_memory_index trust="historical_data" instruction_priority="none" changes_only="true">',
        '+ wmi_a · fact · Deploy process, revised',
        '+ wmi_c · fact · New lesson',
        '- wmi_b',
        'Every memory is listed.',
        '</workspace_memory_index>',
      ].join('\n'),
    );
    expect(decorateUserTurn('hello', changed)).toBe(
      `${changed.memoryIndex}\n\nhello`,
    );
  });

  test('the index rides before the snapshot and comes back whole after a compaction', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const snapshot: WorkspaceMemorySnapshot = {
      ...memory({ id: 'wmi_a' }),
      directory: {
        entries: [{ id: 'wmi_a', kind: 'fact', title: 'Deploy' }],
        total: 1,
      },
    };
    const decorated = decorateUserTurn(
      'hello',
      turn(ledger, 'u1', withIndex(snapshot)),
    );
    expect(decorated.indexOf('<workspace_memory_index')).toBeGreaterThanOrEqual(
      0,
    );
    expect(decorated.indexOf('<workspace_memory_index')).toBeLessThan(
      decorated.indexOf('<workspace_memory_snapshot'),
    );
    ledger.bindSession('s1');
    ledger.stage('u2', withIndex(snapshot));
    ledger.beginCompaction();
    const restored = ledger.restoreAfterCompaction();
    ledger.endCompaction();
    expect(restored).toContain(
      '<workspace_memory_index trust="historical_data" instruction_priority="none">\nwmi_a · fact · Deploy',
    );
    expect(ledger.stage('u3', withIndex(snapshot)).memoryIndex).toBe('');
  });
});
