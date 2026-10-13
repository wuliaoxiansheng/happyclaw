import { describe, expect, test } from 'vitest';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import type {
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';
import {
  EARLY_INPUT_SCAN_MAX,
  extractEarlyToolInputSummary,
  summarizeToolInput,
} from '../container/agent-runner/src/utils.js';

describe('summarizeToolInput names what the call is about', () => {
  // Input shapes as the SDK's tools declare them.
  test.each([
    [
      'Read',
      { file_path: '/repo/src/a.ts', offset: 10, limit: 40 },
      'file_path: /repo/src/a.ts',
    ],
    [
      'Edit',
      {
        file_path: '/repo/src/a.ts',
        old_string: 'a',
        new_string: 'b',
        replace_all: false,
      },
      'file_path: /repo/src/a.ts',
    ],
    [
      'MultiEdit',
      {
        file_path: '/repo/src/a.ts',
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
      'file_path: /repo/src/a.ts',
    ],
    [
      'Write',
      { file_path: '/repo/new.md', content: '# hi' },
      'file_path: /repo/new.md',
    ],
    [
      'NotebookEdit',
      { notebook_path: '/repo/n.ipynb', cell_id: 'c1', new_source: 'x = 1' },
      'notebook_path: /repo/n.ipynb',
    ],
    [
      'WebFetch',
      { url: 'https://example.com/docs', prompt: 'summarize the page' },
      'url: https://example.com/docs',
    ],
    [
      'Grep',
      { pattern: 'TODO', path: 'src', output_mode: 'content' },
      'pattern: TODO',
    ],
    ['Glob', { pattern: '**/*.ts', path: '/repo' }, 'pattern: **/*.ts'],
    [
      'Bash',
      { command: 'npm test', description: 'Run tests' },
      'command: npm test',
    ],
    ['WebSearch', { query: 'claude agent sdk' }, 'query: claude agent sdk'],
  ])('%s', (_tool, input, expected) => {
    expect(summarizeToolInput(input)).toBe(expected);
  });

  test('the keys come in the same order whatever order the input lists them', () => {
    expect(summarizeToolInput({ prompt: 'p', url: 'https://x.test' })).toBe(
      'url: https://x.test',
    );
    expect(summarizeToolInput({ path: 'src', pattern: 'foo' })).toBe(
      'pattern: foo',
    );
  });

  test('other inputs are summarized as before', () => {
    // prompt and name still stand in when nothing better is there.
    expect(
      summarizeToolInput({
        description: 'd',
        prompt: 'do it',
        subagent_type: 'x',
      }),
    ).toBe('prompt: do it');
    expect(summarizeToolInput({ name: 'tool-a', other: 1 })).toBe(
      'name: tool-a',
    );
    expect(summarizeToolInput({ path: '/only/path' })).toBe('path: /only/path');
    expect(summarizeToolInput({ taskId: '1', status: 'in_progress' })).toBe(
      '{"taskId":"1","status":"in_progress"}',
    );
    expect(summarizeToolInput({})).toBeUndefined();
  });

  test('redacts and truncates the chosen value', () => {
    expect(
      summarizeToolInput({ url: 'https://api.test/?api_key=mysecret123abc' }),
    ).toContain('[REDACTED]');
    expect(summarizeToolInput({ file_path: `/${'a'.repeat(300)}` })).toBe(
      `file_path: /${'a'.repeat(179)}...`,
    );
  });
});

describe('extractEarlyToolInputSummary', () => {
  test('waits until a summary key has arrived whole', () => {
    expect(extractEarlyToolInputSummary('')).toBeUndefined();
    expect(extractEarlyToolInputSummary('{')).toBeUndefined();
    expect(extractEarlyToolInputSummary('{"file_pa')).toBeUndefined();
    expect(extractEarlyToolInputSummary('{"file_path"')).toBeUndefined();
    expect(extractEarlyToolInputSummary('{"file_path":')).toBeUndefined();
    expect(
      extractEarlyToolInputSummary('{"file_path":"/repo/sr'),
    ).toBeUndefined();
    expect(extractEarlyToolInputSummary('{"file_path":"/repo/src/a.ts"')).toBe(
      'file_path: /repo/src/a.ts',
    );
  });

  test('never uses a string cut off in an escape', () => {
    expect(extractEarlyToolInputSummary('{"command":"echo \\')).toBeUndefined();
    expect(
      extractEarlyToolInputSummary('{"command":"echo \\"hi'),
    ).toBeUndefined();
    expect(
      extractEarlyToolInputSummary('{"command":"echo \\u00'),
    ).toBeUndefined();
  });

  test('decodes escapes in a complete string', () => {
    expect(
      extractEarlyToolInputSummary('{"command":"echo \\"hi\\" \\u00e9\\n"'),
    ).toBe('command: echo "hi" é');
    expect(
      extractEarlyToolInputSummary('{"file_path":"C:\\\\dir\\\\a.txt"'),
    ).toBe('file_path: C:\\dir\\a.txt');
  });

  test('skips values that are not strings, whatever they contain', () => {
    expect(extractEarlyToolInputSummary('{"timeout":120,"command":"ls"')).toBe(
      'command: ls',
    );
    expect(
      extractEarlyToolInputSummary(
        '{"opts":{"a":"}","b":["]",{"c":"\\""}]},"flag":true,"command":"ls"',
      ),
    ).toBe('command: ls');
    // A number or literal is not whole until a delimiter follows it, and a
    // value that is not a string is no summary even under a summary key.
    expect(extractEarlyToolInputSummary('{"limit":12')).toBeUndefined();
    expect(
      extractEarlyToolInputSummary('{"command":12,"limit":3'),
    ).toBeUndefined();
    expect(
      extractEarlyToolInputSummary('{"opts":{"a":"unclosed'),
    ).toBeUndefined();
  });

  test('picks the best-ranked key among those that have arrived', () => {
    expect(
      extractEarlyToolInputSummary(
        '{"path":"src","pattern":"foo","glob":"*.ts"',
      ),
    ).toBe('pattern: foo');
    expect(
      extractEarlyToolInputSummary('{"prompt":"p","url":"https://x.test"'),
    ).toBe('url: https://x.test');
    // Only what has arrived counts: a better key still to come is not guessed.
    expect(extractEarlyToolInputSummary('{"prompt":"p","ur')).toBe('prompt: p');
  });

  test('ignores empty values, non-objects and malformed JSON', () => {
    expect(
      extractEarlyToolInputSummary('{"command":"","path":"  "'),
    ).toBeUndefined();
    expect(extractEarlyToolInputSummary('["command"]')).toBeUndefined();
    expect(extractEarlyToolInputSummary('"command"')).toBeUndefined();
    expect(extractEarlyToolInputSummary('{command:"ls"')).toBeUndefined();
    expect(extractEarlyToolInputSummary('{"command" "ls"')).toBeUndefined();
  });

  test('matches summarizeToolInput on the same complete input', () => {
    const input = {
      description: 'd',
      pattern: 'a|b',
      path: 'src',
      output_mode: 'content',
    };
    expect(extractEarlyToolInputSummary(JSON.stringify(input))).toBe(
      summarizeToolInput(input),
    );
  });

  test('redacts and truncates like the full summary', () => {
    expect(
      extractEarlyToolInputSummary(
        '{"command":"curl -H \\"Authorization: Bearer eyJhbGc.eyJzdWI.SflKxw\\" https://api"',
      ),
    ).toMatch(/\[REDACTED\]/);
    const long = extractEarlyToolInputSummary(
      `{"file_path":"/${'a'.repeat(400)}"`,
    );
    expect(long).toBe(summarizeToolInput({ file_path: `/${'a'.repeat(400)}` }));
  });

  test('looks only at the first part of the input', () => {
    const late = `{"content":"${'x'.repeat(EARLY_INPUT_SCAN_MAX)}","file_path":"/a.ts"`;
    expect(extractEarlyToolInputSummary(late)).toBeUndefined();
    // A key that completes inside the scanned part is found however much follows.
    const early = `{"file_path":"/a.ts","content":"${'x'.repeat(EARLY_INPUT_SCAN_MAX)}`;
    expect(extractEarlyToolInputSummary(early)).toBe('file_path: /a.ts');
  });
});

describe('the input summary of a streaming tool call', () => {
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
    const summaries = (toolUseId: string): string[] =>
      events()
        .filter(
          (event) =>
            event.eventType === 'tool_progress' &&
            event.toolUseId === toolUseId &&
            event.toolInputSummary !== undefined,
        )
        .map((event) => event.toolInputSummary!);
    return { processor, events, summaries };
  }

  const start = (
    processor: StreamEventProcessor,
    name: string,
    id: string,
    index = 0,
  ) =>
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', name, id, input: {} },
      },
    });
  const delta = (processor: StreamEventProcessor, partial: string, index = 0) =>
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      },
    });
  const frame = (
    processor: StreamEventProcessor,
    name: string,
    id: string,
    input: unknown,
  ) =>
    processor.processAssistantMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id, name, input }],
      },
    });

  test('goes out when the file name is in, not when the Write is complete', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'Write', 'toolu_w');
    delta(processor, '{"file_path":"/repo/src/');
    expect(summaries('toolu_w')).toEqual([]);
    delta(processor, 'big.ts","content":"line 1\\n');
    expect(summaries('toolu_w')).toEqual(['file_path: /repo/src/big.ts']);

    // 40KB of content later nothing more is said, here or in the final frame.
    for (let i = 0; i < 400; i++) delta(processor, `${'y'.repeat(100)}\\n`);
    delta(processor, '"}');
    frame(processor, 'Write', 'toolu_w', {
      file_path: '/repo/src/big.ts',
      content: 'line 1\n',
    });
    expect(summaries('toolu_w')).toEqual(['file_path: /repo/src/big.ts']);
  });

  test('says a WebFetch is about its url, not its prompt', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'WebFetch', 'toolu_f');
    delta(processor, '{"url":"https://example.com/a","pro');
    delta(processor, 'mpt":"what is this"}');
    expect(summaries('toolu_f')).toEqual(['url: https://example.com/a']);
  });

  test('keeps a string with an escaped quote whole', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'Bash', 'toolu_b');
    delta(processor, '{"command":"echo \\"a');
    delta(processor, '\\" && ls');
    expect(summaries('toolu_b')).toEqual([]);
    delta(processor, '","description":"x"}');
    expect(summaries('toolu_b')).toEqual(['command: echo "a" && ls']);
  });

  test('corrects an early summary that a later key outranks', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'WebFetch', 'toolu_f');
    delta(processor, '{"prompt":"read it","url":"https://example.com/a"}');
    expect(summaries('toolu_f')).toEqual(['url: https://example.com/a']);

    // Streamed in two parts, the lower-ranked key goes out first and the
    // complete input then corrects it once.
    start(processor, 'WebFetch', 'toolu_g', 1);
    delta(processor, '{"prompt":"read it",', 1);
    expect(summaries('toolu_g')).toEqual(['prompt: read it']);
    delta(processor, '"url":"https://example.com/b"}', 1);
    expect(summaries('toolu_g')).toEqual([
      'prompt: read it',
      'url: https://example.com/b',
    ]);
  });

  test('a long first value is summarized when the input completes, once', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'Bash', 'toolu_b');
    const command = 'echo '.concat('z'.repeat(EARLY_INPUT_SCAN_MAX + 500));
    delta(processor, `{"command":"${command}`);
    expect(summaries('toolu_b')).toEqual([]);
    delta(processor, '"}');
    expect(summaries('toolu_b')).toEqual([summarizeToolInput({ command })]);
  });

  test('an input too large to hold is summarized from the complete message', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'Write', 'toolu_w');
    const content = 'c'.repeat(30_000);
    // The content comes first, so no summary key arrives within the scan.
    delta(processor, `{"content":"${content.slice(0, 15_000)}`);
    delta(processor, content.slice(15_000));
    delta(processor, '","file_path":"/repo/late.ts"}');
    expect(summaries('toolu_w')).toEqual([]);

    frame(processor, 'Write', 'toolu_w', {
      content,
      file_path: '/repo/late.ts',
    });
    expect(summaries('toolu_w')).toEqual(['file_path: /repo/late.ts']);
  });

  test('a call with no summary key is still summarized as JSON', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'TaskUpdate', 'toolu_t');
    delta(processor, '{"taskId":"1",');
    delta(processor, '"status":"in_progress"}');
    expect(summaries('toolu_t')).toEqual([
      '{"taskId":"1","status":"in_progress"}',
    ]);
  });

  test('redacts a secret in an early summary', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'Bash', 'toolu_b');
    delta(
      processor,
      '{"command":"curl --token mysecret123 https://x.test","d":1}',
    );
    expect(summaries('toolu_b')[0]).toContain('[REDACTED]');
    expect(summaries('toolu_b')[0]).not.toContain('mysecret123');
  });

  test('a sub-agent tool is summarized where it belongs, tracked or not', () => {
    const { processor, events } = makeProcessor();
    const nested = (event: Record<string, unknown>) =>
      processor.processStreamEvent({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_task',
        event,
      });
    nested({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        name: 'Read',
        id: 'toolu_in',
        input: {},
      },
    });
    nested({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"file_path":"/repo/in.ts","limit":5}',
      },
    });
    expect(events().filter((e) => e.toolInputSummary !== undefined)).toEqual([
      {
        eventType: 'tool_progress',
        toolName: 'Read',
        toolUseId: 'toolu_in',
        parentToolUseId: 'toolu_task',
        isNested: true,
        toolInputSummary: 'file_path: /repo/in.ts',
      },
    ]);
  });

  test('tools with their own input handling are left to it', () => {
    const { processor, summaries } = makeProcessor();
    start(processor, 'Skill', 'toolu_s');
    delta(processor, '{"skill":"commit","args":"-m x"}');
    expect(summaries('toolu_s')).toEqual([]);
    frame(processor, 'Skill', 'toolu_s', { skill: 'commit', args: '-m x' });
    expect(summaries('toolu_s')).toEqual([]);
  });
});
