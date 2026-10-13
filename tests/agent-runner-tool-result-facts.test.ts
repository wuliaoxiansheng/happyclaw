import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import { extractToolResultFacts } from '../container/agent-runner/src/tool-result-facts.js';
import type {
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';

interface Sample {
  toolName: string;
  isError?: boolean;
  content: unknown;
  toolUseResult: unknown;
}

// Real tool_use_result shapes (CLI 2.1.296) with every string made a placeholder.
const samples = (
  JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/sdk-tool-use-results.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: Record<string, Sample> }
).cases;

/** Every leaf of a value, to prove no string rides along. */
function leaves(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [value];
  return Object.values(value).flatMap(leaves);
}

function makeProcessor() {
  const outputs: ContainerOutput[] = [];
  const processor = new StreamEventProcessor(
    (output) => outputs.push(output),
    () => {},
  );
  const events = (): StreamEvent[] =>
    outputs.flatMap((output) =>
      output.streamEvent ? [output.streamEvent] : [],
    );
  const results = (): StreamEvent[] =>
    events().filter((event) => event.eventType === 'tool_result');
  return { processor, events, results };
}

function startTool(
  processor: StreamEventProcessor,
  name: string,
  id: string,
  index = 0,
) {
  processor.processStreamEvent({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', name, id, input: {} },
    },
  });
}

/** A user message the way the SDK delivers one tool's result. */
function resultMessage(
  id: string,
  sample: Pick<Sample, 'content' | 'isError' | 'toolUseResult'>,
) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: sample.content,
          ...(sample.isError === undefined ? {} : { is_error: sample.isError }),
        },
      ],
    },
    ...(sample.toolUseResult === undefined
      ? {}
      : { tool_use_result: sample.toolUseResult }),
  };
}

describe('extractToolResultFacts', () => {
  const factsOf = (key: string) => {
    const sample = samples[key];
    return extractToolResultFacts(sample.toolName, sample.toolUseResult, {
      isError: sample.isError,
      content: sample.content,
    });
  };

  test.each([
    // Read: numLines counts the final newline's empty line, as the SDK reports.
    ['read', { lines: 4, totalLines: 4 }],
    ['write', { created: true, added: 2 }],
    ['writeUpdate', { created: false, added: 1, removed: 0 }],
    ['edit', { added: 1, removed: 1 }],
    ['glob', { files: 2, matches: 2, durationMs: 33 }],
    // numFiles is 0 in content mode: not a count of anything, so not reported.
    ['grepContent', { matches: 1 }],
    ['grepCount', { matches: 17, files: 3 }],
    ['grepFiles', { files: 2 }],
    ['bashExit3', { exitCode: 3 }],
    ['bashExit1', { exitCode: 1 }],
    ['webFetch', { httpCode: 200, bytes: 2048, durationMs: 311 }],
    ['webSearch', { searches: 1, durationMs: 471 }],
    [
      'agent',
      {
        agent: {
          toolUses: 2,
          reads: 1,
          searches: 0,
          edits: 0,
          commands: 1,
          added: 0,
          removed: 0,
          tokens: 190,
          durationMs: 2248,
        },
      },
    ],
  ])('%s', (key, expected) => {
    expect(factsOf(key)).toEqual(expected);
  });

  test.each(['bashSuccess', 'readMissing', 'taskCreate', 'taskList'])(
    '%s has no facts',
    (key) => {
      expect(factsOf(key)).toBeUndefined();
    },
  );

  test('facts hold numbers and booleans only, never a string', () => {
    for (const key of Object.keys(samples)) {
      const facts = factsOf(key);
      for (const leaf of leaves(facts ?? {})) {
        expect(['number', 'boolean']).toContain(typeof leaf);
      }
    }
    // Whatever a result is stuffed with, it does not come through.
    const facts = extractToolResultFacts(
      'Agent',
      {
        ...(samples.agent.toolUseResult as object),
        agentId: 'secret-id',
        totalToolUseCount: '7',
        toolStats: { readCount: 'SECRET', searchCount: 2 },
        filenames: ['/etc/passwd'],
      },
      {},
    );
    expect(facts).toEqual({
      agent: expect.objectContaining({ searches: 2, tokens: 190 }),
    });
    expect(JSON.stringify(facts)).not.toMatch(/secret|passwd|SECRET/i);
    expect(facts?.agent).not.toHaveProperty('toolUses');
    expect(facts?.agent).not.toHaveProperty('reads');
  });

  test('counts every hunk of an edit by the +/- prefix of its lines', () => {
    expect(
      extractToolResultFacts('Edit', {
        structuredPatch: [
          { lines: [' ctx', '-old a', '-old b', '+new a'] },
          { lines: [' ctx', '+new b', '+new c', '--dashes', '++plus', ' ctx'] },
        ],
      }),
    ).toEqual({ added: 4, removed: 3 });
    expect(
      extractToolResultFacts('MultiEdit', { structuredPatch: [] }),
    ).toEqual({
      added: 0,
      removed: 0,
    });
    // No patch, no claim; a held-back edit changed nothing.
    expect(extractToolResultFacts('Edit', { filePath: 'x' })).toBeUndefined();
    expect(
      extractToolResultFacts('Edit', {
        staged: true,
        structuredPatch: [{ lines: ['+a'] }],
      }),
    ).toBeUndefined();
  });

  test('counts the lines of a created file by newline, without its text', () => {
    const created = (content: unknown) =>
      extractToolResultFacts('Write', { type: 'create', content });
    expect(created('a\nb\nc\n')).toEqual({ created: true, added: 3 });
    expect(created('a\nb\nc')).toEqual({ created: true, added: 3 });
    expect(created('one line')).toEqual({ created: true, added: 1 });
    expect(created('')).toEqual({ created: true, added: 0 });
    expect(created(undefined)).toEqual({ created: true });
  });

  test('reads a failed command exit code from the text, never a successful one', () => {
    const bash = (toolUseResult: unknown, content: unknown, isError = true) =>
      extractToolResultFacts('Bash', toolUseResult, { isError, content });
    expect(bash('Error: Exit code 127\nnot found', undefined)).toEqual({
      exitCode: 127,
    });
    expect(bash(undefined, 'Exit code 2\nboom')).toEqual({ exitCode: 2 });
    expect(bash(undefined, [{ type: 'text', text: 'Exit code 9' }])).toEqual({
      exitCode: 9,
    });
    expect(bash('Error: killed', 'Exit code 4')).toEqual({ exitCode: 4 });
    expect(bash('Error: killed', 'killed')).toBeUndefined();
    expect(
      bash(undefined, 'the Exit code 5 was in the middle'),
    ).toBeUndefined();
    // stdout that merely starts like a failure is not one.
    expect(
      bash({ stdout: 'x' }, 'Exit code 9\nthat was the output', false),
    ).toBeUndefined();
    expect(bash(undefined, 'Exit code 9', false)).toBeUndefined();
    // Only a shell tool reports one.
    expect(
      extractToolResultFacts('Read', 'Error: Exit code 3', { isError: true }),
    ).toBeUndefined();
  });

  test('keeps only valid numbers', () => {
    const glob = (result: Record<string, unknown>) =>
      extractToolResultFacts('Glob', result);
    expect(
      glob({
        numFiles: -1,
        totalMatches: 1.5,
        durationMs: Number.NaN,
      }),
    ).toBeUndefined();
    expect(
      glob({
        numFiles: '3',
        totalMatches: Number.POSITIVE_INFINITY,
        durationMs: -5,
      }),
    ).toBeUndefined();
    // Counts are whole, durations are rounded, and nothing exceeds 1e9.
    expect(glob({ numFiles: 4, totalMatches: 5e12, durationMs: 33.6 })).toEqual(
      { files: 4, matches: 1e9, durationMs: 34 },
    );
    expect(
      extractToolResultFacts('WebSearch', {
        searchCount: 2,
        durationSeconds: 0.0004,
      }),
    ).toEqual({ searches: 2, durationMs: 0 });
  });

  test('says nothing about an unknown tool or an unfamiliar shape', () => {
    expect(extractToolResultFacts(undefined, { numFiles: 1 })).toBeUndefined();
    expect(
      extractToolResultFacts('mcp__srv__lookup', { numFiles: 1 }),
    ).toBeUndefined();
    for (const shape of [
      undefined,
      null,
      7,
      'Error: x',
      [],
      [{ numFiles: 1 }],
      true,
    ]) {
      expect(extractToolResultFacts('Glob', shape)).toBeUndefined();
      expect(extractToolResultFacts('Read', shape)).toBeUndefined();
      expect(extractToolResultFacts('Agent', shape)).toBeUndefined();
    }
    // A call that stepped aside for a user message has no output yet.
    expect(
      extractToolResultFacts('WebFetch', { detachedToolCall: true }),
    ).toBeUndefined();
    // A file Read of another kind (image, pdf) has no lines to count.
    expect(
      extractToolResultFacts('Read', { type: 'image', file: { base64: 'x' } }),
    ).toBeUndefined();
  });
});

describe('tool_result events of the main agent', () => {
  test.each([
    'read',
    'write',
    'writeUpdate',
    'edit',
    'glob',
    'grepContent',
    'bashExit3',
    'webSearch',
    'agent',
  ])('%s carries its facts from the structured result', (key) => {
    const sample = samples[key];
    const { processor, results } = makeProcessor();
    startTool(processor, sample.toolName, 'toolu_1');
    processor.processMainToolResults(resultMessage('toolu_1', sample));

    const [event] = results();
    expect(event.toolUseId).toBe('toolu_1');
    expect(event.toolResultFacts).toEqual(
      extractToolResultFacts(sample.toolName, sample.toolUseResult, {
        isError: sample.isError,
        content: sample.content,
      }),
    );
    expect(event.toolResultFacts).toBeDefined();
    for (const leaf of leaves(event.toolResultFacts)) {
      expect(['number', 'boolean']).toContain(typeof leaf);
    }
  });

  test('every result says whether it failed: the SDK leaves is_error out on success', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'Bash', 'toolu_fail', 0);
    startTool(processor, 'Bash', 'toolu_ok', 1);
    startTool(processor, 'Read', 'toolu_unset', 2);
    processor.processMainToolResults(
      resultMessage('toolu_fail', samples.bashExit3),
    );
    processor.processMainToolResults(
      resultMessage('toolu_ok', samples.bashSuccess),
    );
    // The fixture's Read result has no is_error, as the SDK sends it.
    expect(samples.read).not.toHaveProperty('isError');
    processor.processMainToolResults(
      resultMessage('toolu_unset', samples.read),
    );

    const [fail, ok, unset] = results();
    expect(fail.toolIsError).toBe(true);
    expect(fail.toolResult).toBe('⚠️ Exit code 3\n<output>');
    expect(ok.toolIsError).toBe(false);
    expect(ok.toolResult).toBe('<content>');
    expect(unset.toolIsError).toBe(false);
  });

  test('a successful output that begins with the failure mark is not marked as a failure', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'Bash', 'toolu_warn');
    processor.processMainToolResults(
      resultMessage('toolu_warn', {
        content: '⚠️ heads up: nothing is wrong',
        toolUseResult: { stdout: '⚠️ heads up: nothing is wrong', stderr: '' },
      }),
    );
    expect(results()[0]).toMatchObject({
      toolIsError: false,
      toolResult: '⚠️ heads up: nothing is wrong',
    });
    // A failure carries the mark the Runner adds, and the flag.
    const failed = makeProcessor();
    startTool(failed.processor, 'Bash', 'toolu_bad');
    failed.processor.processMainToolResults(
      resultMessage('toolu_bad', {
        content: '⚠️ heads up: nothing is wrong',
        isError: true,
        toolUseResult: undefined,
      }),
    );
    expect(failed.results()[0]).toMatchObject({
      toolIsError: true,
      toolResult: '⚠️ ⚠️ heads up: nothing is wrong',
    });
  });

  test('a failure with no output is still reported, as a failure', () => {
    for (const content of ['', [], [{ type: 'text', text: '' }], undefined]) {
      const { processor, results, events } = makeProcessor();
      startTool(processor, 'mcp__srv__lookup', 'toolu_e');
      processor.processMainToolResults(
        resultMessage('toolu_e', {
          content,
          isError: true,
          toolUseResult: undefined,
        }),
      );
      expect(results()).toEqual([
        { eventType: 'tool_result', toolUseId: 'toolu_e', toolIsError: true },
      ]);
      // The tool still ends as it did.
      expect(events().map((e) => e.eventType)).toEqual([
        'tool_use_start',
        'tool_result',
        'tool_use_end',
      ]);
    }
  });

  test('an empty success is not an event', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'mcp__srv__lookup', 'toolu_e');
    processor.processMainToolResults(
      resultMessage('toolu_e', {
        content: '',
        isError: false,
        toolUseResult: undefined,
      }),
    );
    expect(results()).toEqual([]);
  });

  test('a string-form error gives the exit code and nothing else', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'Bash', 'toolu_b');
    processor.processMainToolResults(
      resultMessage('toolu_b', {
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
        toolUseResult: 'Error: Exit code 5\nsomething went wrong',
      }),
    );
    expect(results()[0]).toMatchObject({
      toolIsError: true,
      toolResultFacts: { exitCode: 5 },
    });

    const second = makeProcessor();
    startTool(second.processor, 'Read', 'toolu_r');
    second.processor.processMainToolResults(
      resultMessage('toolu_r', samples.readMissing),
    );
    expect(second.results()[0].toolIsError).toBe(true);
    expect(second.results()[0]).not.toHaveProperty('toolResultFacts');
  });

  test('a result with no structured counterpart has no facts and keeps its text', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'Glob', 'toolu_g');
    const message = resultMessage('toolu_g', samples.glob);
    delete (message as { tool_use_result?: unknown }).tool_use_result;
    processor.processMainToolResults(message);
    expect(results()).toEqual([
      {
        eventType: 'tool_result',
        toolUseId: 'toolu_g',
        toolResult: '<content>',
        detail: '<content>',
        toolIsError: false,
      },
    ]);
  });

  test('a message with several results does not guess whose facts they are', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'Glob', 'toolu_g', 0);
    startTool(processor, 'Read', 'toolu_r', 1);
    processor.processMainToolResults({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_g', content: 'a' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_r',
            content: 'b',
            is_error: true,
          },
        ],
      },
      tool_use_result: samples.glob.toolUseResult,
    });
    expect(results().map((e) => e.toolResultFacts)).toEqual([
      undefined,
      undefined,
    ]);
    expect(results().map((e) => e.toolIsError)).toEqual([false, true]);
  });

  test('a tool never seen starting has no facts; an assistant frame is enough to name it', () => {
    const { processor, results } = makeProcessor();
    processor.processMainToolResults(resultMessage('toolu_x', samples.glob));
    expect(results()[0]).not.toHaveProperty('toolResultFacts');

    processor.processAssistantMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg-1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_y',
            name: 'Glob',
            input: { pattern: '*' },
          },
        ],
      },
    });
    processor.processMainToolResults(resultMessage('toolu_y', samples.glob));
    expect(results()[1].toolResultFacts).toEqual({
      files: 2,
      matches: 2,
      durationMs: 33,
    });
  });

  test('a result is read by the name of the tool it answers, which is then forgotten', () => {
    const { processor, results } = makeProcessor();
    startTool(processor, 'Read', 'toolu_1');
    processor.processMainToolResults(resultMessage('toolu_1', samples.glob));
    // Read has no files/matches, so the Glob-shaped result gives it nothing.
    expect(results()[0]).not.toHaveProperty('toolResultFacts');
    processor.processMainToolResults(resultMessage('toolu_1', samples.read));
    expect(results()[1]).not.toHaveProperty('toolResultFacts');
  });

  test('a sub-agent tool result is left as it was', () => {
    const { processor, events } = makeProcessor();
    startTool(processor, 'Agent', 'toolu_task');
    expect(
      processor.processSubAgentMessage({
        type: 'assistant',
        parent_tool_use_id: 'toolu_task',
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_inner',
              name: 'Bash',
              input: { command: 'false' },
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      processor.processSubAgentMessage({
        ...resultMessage('toolu_inner', samples.bashExit1),
        parent_tool_use_id: 'toolu_task',
        tool_use_result: samples.bashExit1.toolUseResult,
      }),
    ).toBe(true);
    const inner = events().filter(
      (e) => e.eventType === 'tool_result' && e.toolUseId === 'toolu_inner',
    );
    expect(inner).toEqual([
      {
        eventType: 'tool_result',
        toolUseId: 'toolu_inner',
        toolResult: '⚠️ Exit code 1',
        detail: '⚠️ Exit code 1',
        parentToolUseId: 'toolu_task',
      },
    ]);
    // And the main-agent path ignores a message that belongs to a sub-agent.
    processor.processMainToolResults({
      ...resultMessage('toolu_inner', samples.bashExit1),
      parent_tool_use_id: 'toolu_task',
    });
    expect(events().filter((e) => e.eventType === 'tool_result')).toHaveLength(
      1,
    );
  });

  test('a sub-agent calling many tools does not push its Task out of the table', () => {
    const { processor, results, events } = makeProcessor();
    startTool(processor, 'Agent', 'toolu_task');
    // 600 tool calls under the Task, each streamed with its input as the
    // sub-agent's own events arrive.
    for (let i = 0; i < 600; i++) {
      processor.processStreamEvent({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_task',
        event: {
          type: 'content_block_start',
          index: i,
          content_block: {
            type: 'tool_use',
            name: 'Read',
            id: `toolu_inner_${i}`,
            input: {},
          },
        },
      });
    }
    processor.processMainToolResults(
      resultMessage('toolu_task', samples.agent),
    );
    expect(results()[0].toolResultFacts?.agent).toEqual({
      toolUses: 2,
      reads: 1,
      searches: 0,
      edits: 0,
      commands: 1,
      added: 0,
      removed: 0,
      tokens: 190,
      durationMs: 2248,
    });
    // The sub-agent's tools were announced all the same.
    expect(
      events().filter(
        (e) => e.eventType === 'tool_use_start' && e.isNested === true,
      ),
    ).toHaveLength(600);
  });

  test('no event carries a string beyond the result text it always had', () => {
    const { processor, results } = makeProcessor();
    let index = 0;
    for (const [key, sample] of Object.entries(samples)) {
      startTool(processor, sample.toolName, `toolu_${key}`, index++);
      processor.processMainToolResults(resultMessage(`toolu_${key}`, sample));
    }
    expect(results().length).toBeGreaterThan(10);
    for (const event of results()) {
      for (const leaf of leaves(event.toolResultFacts ?? {})) {
        expect(['number', 'boolean']).toContain(typeof leaf);
      }
    }
  });
});
