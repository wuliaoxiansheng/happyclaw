import { describe, expect, test } from 'vitest';

import {
  isPollingToolCall,
  ToolLoopDetector,
  toolCallFingerprint,
  type ToolLoopHit,
} from '../container/agent-runner/src/tool-loop-detector.js';

type Call = { name: string; input: unknown };

const bash = (command: string): Call => ({ name: 'Bash', input: { command } });
const read = (file_path: string): Call => ({
  name: 'Read',
  input: { file_path },
});
const grep = (pattern: string): Call => ({ name: 'Grep', input: { pattern } });

/** Feed calls into one scope; return every hit with the call index that tripped it. */
function run(calls: Call[]): Array<[number, ToolLoopHit]> {
  const detector = new ToolLoopDetector();
  const hits: Array<[number, ToolLoopHit]> = [];
  calls.forEach((call, index) => {
    for (const hit of detector.observeCall('main', call)) {
      hits.push([index + 1, hit]);
    }
  });
  return hits;
}

const cycle = (calls: Call[], times: number): Call[] =>
  Array.from({ length: times }, () => calls).flat();

describe('tool call fingerprints', () => {
  test('key order does not matter, values do', () => {
    expect(toolCallFingerprint('Edit', { a: 1, b: { c: 2, d: [3] } })).toBe(
      toolCallFingerprint('Edit', { b: { d: [3], c: 2 }, a: 1 }),
    );
    expect(toolCallFingerprint('Edit', { a: 1 })).not.toBe(
      toolCallFingerprint('Edit', { a: 2 }),
    );
    expect(toolCallFingerprint('Edit', { a: 1 })).not.toBe(
      toolCallFingerprint('Write', { a: 1 }),
    );
    expect(toolCallFingerprint('Edit', { a: 1, b: undefined })).toBe(
      toolCallFingerprint('Edit', { a: 1 }),
    );
  });

  test('a fingerprint holds a digest, not the input, still telling inputs apart', () => {
    const long = 'x'.repeat(5_000);
    const fingerprint = toolCallFingerprint('Write', { content: long });
    expect(fingerprint).not.toContain(long);
    expect(fingerprint.length).toBeLessThan(100);
    expect(fingerprint).toBe(toolCallFingerprint('Write', { content: long }));
    expect(fingerprint).not.toBe(
      toolCallFingerprint('Write', { content: `${long}y` }),
    );
  });
});

describe('polling calls', () => {
  test.each<[string, Call, boolean]>([
    [
      'legacy background output reader',
      { name: 'TaskOutput', input: {} },
      true,
    ],
    ['legacy Bash output reader', { name: 'BashOutput', input: {} }, true],
    ['Monitor', { name: 'Monitor', input: { description: 'x' } }, true],
    ['team task list', { name: 'TaskList', input: {} }, true],
    [
      'automation run status',
      { name: 'mcp__happyclaw__automation_list_runs', input: { id: 'a' } },
      true,
    ],
    ['background task output file', read('/tmp/tasks/b1a2.output'), true],
    ['sleep then check', bash('sleep 30 && gh run view 1'), true],
    ['ordinary file read', read('/repo/src/index.ts'), false],
    ['ordinary command', bash('npm test'), false],
    ['sleep later in a command', bash('npm test; sleep 5'), false],
    [
      'ordinary MCP tool',
      { name: 'mcp__happyclaw__send_message', input: {} },
      false,
    ],
  ])('%s', (_name, call, polling) => {
    expect(isPollingToolCall(call.name, call.input)).toBe(polling);
  });
});

describe('tool loop rules', () => {
  test.each<[string, Call[], Array<[number, Partial<ToolLoopHit>]>]>([
    [
      'the same call four times in a row',
      cycle([bash('ls')], 4),
      [[4, { rule: 'repeat', tool: 'Bash', count: 4, distinct: 1 }]],
    ],
    ['three repeats are not enough', cycle([bash('ls')], 3), []],
    [
      'a streak broken by a different call starts again',
      [...cycle([bash('ls')], 3), bash('pwd'), ...cycle([bash('ls')], 3)],
      [],
    ],
    [
      'polling between repeats neither counts nor breaks the streak',
      [
        bash('ls'),
        read('/tmp/t.output'),
        bash('ls'),
        { name: 'TaskOutput', input: {} },
        bash('ls'),
        bash('ls'),
      ],
      [[6, { rule: 'repeat', count: 4 }]],
    ],
    [
      'two calls alternating across a full window of 12',
      cycle([read('/a.ts'), grep('foo')], 6),
      [[12, { rule: 'pingpong', tool: 'Read,Grep', count: 12, distinct: 2 }]],
    ],
    [
      'four calls rotating across a full window of 16',
      cycle([read('/a.ts'), read('/b.ts'), grep('x'), grep('y')], 4),
      [[16, { rule: 'rotation', tool: 'Read,Grep', count: 16, distinct: 4 }]],
    ],
    [
      'three calls rotating trip the rotation rule only',
      [...cycle([bash('a'), bash('b'), bash('c')], 5), bash('a')],
      [[16, { rule: 'rotation', distinct: 3 }]],
    ],
    [
      'five rotating calls are ordinary work',
      cycle([bash('a'), bash('b'), bash('c'), bash('d'), bash('e')], 6),
      [],
    ],
    [
      'an investigation reading different files is not a loop',
      Array.from({ length: 40 }, (_, index) => read(`/src/file-${index}.ts`)),
      [],
    ],
    [
      'a long repeat is reported once, by the first rule it trips',
      cycle([bash('ls')], 40),
      [[4, { rule: 'repeat', count: 4 }]],
    ],
    [
      'after one report the scope stays quiet for the input',
      [...cycle([bash('ls')], 4), ...cycle([read('/a.ts'), grep('foo')], 6)],
      [[4, { rule: 'repeat' }]],
    ],
  ])('%s', (_name, calls, expected) => {
    const hits = run(calls);
    expect(hits).toHaveLength(expected.length);
    expected.forEach(([index, hit], position) => {
      expect(hits[position]![0]).toBe(index);
      expect(hits[position]![1]).toMatchObject({ scope: 'main', ...hit });
    });
  });

  test('scopes are counted apart: the main Agent and each sub-agent', () => {
    const detector = new ToolLoopDetector();
    const assistant = (parent: string | null, id: string, command: string) => ({
      parent_tool_use_id: parent,
      message: {
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'tool_use', id, name: 'Bash', input: { command } },
        ],
      },
    });
    const hits: ToolLoopHit[] = [];
    for (let index = 0; index < 3; index++) {
      hits.push(
        ...detector.observeAssistantMessage(assistant(null, `m${index}`, 'ls')),
        ...detector.observeAssistantMessage(
          assistant('toolu_parent_a', `a${index}`, 'ls'),
        ),
      );
    }
    // Interleaved, each scope has three repeats: nothing yet.
    expect(hits).toEqual([]);
    expect(
      detector.observeAssistantMessage(assistant('toolu_parent_a', 'a3', 'ls')),
    ).toEqual([
      {
        scope: 'subagent:toolu_parent_a',
        rule: 'repeat',
        tool: 'Bash',
        count: 4,
        distinct: 1,
      },
    ]);
    // A sub-agent of another parent starts from nothing.
    expect(
      detector.observeAssistantMessage(assistant('toolu_parent_b', 'b0', 'ls')),
    ).toEqual([]);
  });

  test('reset() starts the next input afresh', () => {
    const detector = new ToolLoopDetector();
    const trips = () =>
      cycle([bash('ls')], 4).flatMap((call) =>
        detector.observeCall('main', call),
      );
    expect(trips()).toHaveLength(1);
    expect(trips()).toEqual([]);
    detector.reset();
    expect(trips()).toEqual([
      expect.objectContaining({ rule: 'repeat', scope: 'main' }),
    ]);
  });
});
