import { describe, expect, it } from 'vitest';
import {
  compactCount,
  formatResultFacts,
  formatTaskUsage,
  splitResultFacts,
} from '../src/lib/process-facts';

describe('formatResultFacts, edits', () => {
  it('counts the lines added and removed, with the real minus sign', () => {
    const text = formatResultFacts('Edit', { added: 12, removed: 3 }, false);
    expect(text).toBe('+12 −3');
    expect(text).toContain('−');
    expect(text).not.toContain('-');
  });

  it('leaves out the side that has nothing in it', () => {
    expect(formatResultFacts('Edit', { added: 12 }, false)).toBe('+12');
    expect(formatResultFacts('Edit', { added: 12, removed: 0 }, false)).toBe(
      '+12',
    );
    expect(formatResultFacts('Edit', { removed: 4 }, false)).toBe('−4');
    expect(formatResultFacts('Edit', { added: 0, removed: 0 }, false)).toBe(
      null,
    );
  });

  it('reads the same for every tool that edits a file', () => {
    for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']) {
      expect(formatResultFacts(tool, { added: 2, removed: 1 }, false)).toBe(
        '+2 −1',
      );
    }
  });

  it('says a Write made the file, then how long it is', () => {
    expect(
      formatResultFacts('Write', { created: true, added: 24 }, false),
    ).toBe('新建 · +24');
    expect(formatResultFacts('Write', { created: true }, false)).toBe('新建');
    expect(formatResultFacts('Write', { added: 3, removed: 10 }, false)).toBe(
      '+3 −10',
    );
    // Only a Write creates.
    expect(formatResultFacts('Edit', { created: true, added: 1 }, false)).toBe(
      '+1',
    );
  });
});

describe('formatResultFacts, reading and searching', () => {
  it('counts the lines a Read returned, and of how many when it was cut', () => {
    expect(formatResultFacts('Read', { lines: 120 }, false)).toBe('120 行');
    expect(
      formatResultFacts('Read', { lines: 120, totalLines: 430 }, false),
    ).toBe('120/430 行');
    expect(
      formatResultFacts('Read', { lines: 430, totalLines: 430 }, false),
    ).toBe('430 行');
    // An empty file is worth saying.
    expect(formatResultFacts('Read', { lines: 0 }, false)).toBe('0 行');
    // The total alone is not what was read.
    expect(formatResultFacts('Read', { totalLines: 430 }, false)).toBeNull();
  });

  it('counts the files a Glob found, none included', () => {
    expect(formatResultFacts('Glob', { files: 8 }, false)).toBe('8 个文件');
    expect(formatResultFacts('Glob', { files: 0 }, false)).toBe('0 个文件');
    expect(formatResultFacts('Glob', {}, false)).toBeNull();
  });

  it('counts the matches of a Grep and the files they are in, whichever it has', () => {
    expect(formatResultFacts('Grep', { matches: 24, files: 8 }, false)).toBe(
      '24 处匹配 · 8 个文件',
    );
    expect(formatResultFacts('Grep', { matches: 24 }, false)).toBe('24 处匹配');
    expect(formatResultFacts('Grep', { files: 8 }, false)).toBe('8 个文件');
    expect(formatResultFacts('Grep', {}, false)).toBeNull();
    // No match says there are no files.
    expect(formatResultFacts('Grep', { matches: 0, files: 0 }, false)).toBe(
      '0 处匹配',
    );
  });
});

describe('formatResultFacts, commands and the web', () => {
  it('gives the exit code of a command that failed, and only then', () => {
    expect(formatResultFacts('Bash', { exitCode: 1 }, true)).toBe('退出码 1');
    expect(formatResultFacts('Bash', { exitCode: 127 }, true)).toBe(
      '退出码 127',
    );
    expect(formatResultFacts('Bash', { exitCode: 1 }, false)).toBeNull();
    expect(formatResultFacts('Bash', { durationMs: 900 }, true)).toBeNull();
    expect(formatResultFacts('Bash', {}, true)).toBeNull();
  });

  it('gives the status and size of a fetched page', () => {
    expect(
      formatResultFacts('WebFetch', { httpCode: 200, bytes: 14 * 1024 }, false),
    ).toBe('HTTP 200 · 14 KB');
    expect(formatResultFacts('WebFetch', { httpCode: 404 }, false)).toBe(
      'HTTP 404',
    );
    expect(formatResultFacts('WebFetch', { bytes: 2048 }, false)).toBe('2 KB');
    expect(formatResultFacts('WebFetch', {}, false)).toBeNull();
  });

  it('writes a size in the unit that suits it', () => {
    const size = (bytes: number) =>
      formatResultFacts('WebFetch', { bytes }, false);
    expect(size(0)).toBe('0 B');
    expect(size(512)).toBe('512 B');
    expect(size(1536)).toBe('1.5 KB');
    expect(size(14 * 1024)).toBe('14 KB');
    expect(size(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(size(30 * 1024 * 1024)).toBe('30 MB');
  });

  it('counts the searches a WebSearch made', () => {
    expect(formatResultFacts('WebSearch', { searches: 1 }, false)).toBe(
      '搜索 1 次',
    );
    expect(formatResultFacts('WebSearch', { searches: 0 }, false)).toBeNull();
  });
});

describe('formatResultFacts, a sub-agent', () => {
  const full = {
    reads: 3,
    searches: 2,
    edits: 1,
    commands: 4,
    added: 12,
    removed: 3,
    tokens: 12_345,
    durationMs: 46_000,
  };

  it('sums up its work, its lines and its cost', () => {
    expect(formatResultFacts('Agent', { agent: full }, false)).toBe(
      '读 3 · 搜 2 · 改 1 · 命令 4 · +12 −3 · 1.2 万 token · 46 秒',
    );
    expect(formatResultFacts('Task', { agent: full }, false)).toBe(
      '读 3 · 搜 2 · 改 1 · 命令 4 · +12 −3 · 1.2 万 token · 46 秒',
    );
  });

  it('leaves out what is zero or missing', () => {
    expect(
      formatResultFacts(
        'Agent',
        {
          agent: { reads: 3, searches: 0, edits: 0, commands: 0, tokens: 800 },
        },
        false,
      ),
    ).toBe('读 3 · 800 token');
    expect(
      formatResultFacts('Agent', { agent: { durationMs: 72_000 } }, false),
    ).toBe('1 分 12 秒');
    // Under a second is not worth a word.
    expect(
      formatResultFacts(
        'Agent',
        { agent: { reads: 1, durationMs: 400 } },
        false,
      ),
    ).toBe('读 1');
  });

  it('counts the tools it used only when it cannot tell them apart', () => {
    expect(
      formatResultFacts(
        'Agent',
        { agent: { toolUses: 14, tokens: 12_000, durationMs: 46_000 } },
        false,
      ),
    ).toBe('14 个工具 · 1.2 万 token · 46 秒');
    expect(
      formatResultFacts('Agent', { agent: { toolUses: 14, reads: 5 } }, false),
    ).toBe('读 5');
  });

  it('has nothing to say of a sub-agent that did nothing or told nothing', () => {
    expect(formatResultFacts('Agent', { agent: {} }, false)).toBeNull();
    expect(
      formatResultFacts('Agent', { agent: { reads: 0, tokens: 0 } }, false),
    ).toBeNull();
    expect(formatResultFacts('Agent', { reads: 3 }, false)).toBeNull();
  });
});

describe('formatResultFacts, what it does not know', () => {
  it('has no line without facts, or for a tool it has no words for', () => {
    expect(formatResultFacts('Edit', undefined, false)).toBeNull();
    expect(formatResultFacts('Edit', {}, false)).toBeNull();
    expect(formatResultFacts('Skill', { lines: 4 }, false)).toBeNull();
    expect(formatResultFacts('TodoWrite', { added: 4 }, false)).toBeNull();
    expect(formatResultFacts('mcp__srv__tool', { files: 4 }, false)).toBeNull();
    expect(formatResultFacts('unknown', { files: 4 }, false)).toBeNull();
  });

  it('ignores a number that is not one', () => {
    expect(formatResultFacts('Read', { lines: Number.NaN }, false)).toBeNull();
    expect(formatResultFacts('Read', { lines: -3 }, false)).toBeNull();
    expect(
      formatResultFacts('Edit', { added: Number.POSITIVE_INFINITY }, false),
    ).toBeNull();
  });
});

describe('compactCount', () => {
  it('writes a count in the shortest form that reads at a glance', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(800)).toBe('800');
    expect(compactCount(1200)).toBe('1.2 千');
    expect(compactCount(1000)).toBe('1 千');
    expect(compactCount(9949)).toBe('9.9 千');
    expect(compactCount(12_345)).toBe('1.2 万');
    expect(compactCount(123_456)).toBe('12.3 万');
    expect(compactCount(1_234_567)).toBe('123 万');
    expect(compactCount(250_000_000)).toBe('2.5 亿');
  });

  it('carries into the next unit instead of showing 10', () => {
    expect(compactCount(9950)).toBe('1 万');
    expect(compactCount(9999)).toBe('1 万');
    expect(compactCount(99_500_000)).toBe('1 亿');
  });
});

describe('formatTaskUsage', () => {
  it('says what a running sub-agent has cost so far', () => {
    expect(
      formatTaskUsage({
        totalTokens: 12_000,
        toolUses: 14,
        durationMs: 46_000,
      }),
    ).toBe('14 个工具 · 1.2 万 token · 46 秒');
    expect(
      formatTaskUsage({ totalTokens: 0, toolUses: 2, durationMs: 300 }),
    ).toBe('2 个工具');
  });

  it('has nothing to say before it has cost anything', () => {
    expect(formatTaskUsage(undefined)).toBeNull();
    expect(
      formatTaskUsage({ totalTokens: 0, toolUses: 0, durationMs: 0 }),
    ).toBeNull();
  });
});

describe('splitResultFacts', () => {
  it('cuts the lines added and removed out of the line', () => {
    expect(splitResultFacts('+12 −3')).toEqual([
      { text: '+12', tone: 'added' },
      { text: ' ' },
      { text: '−3', tone: 'removed' },
    ]);
    expect(splitResultFacts('读 3 · +12 −3 · 1.2 万 token')).toEqual([
      { text: '读 3 · ' },
      { text: '+12', tone: 'added' },
      { text: ' ' },
      { text: '−3', tone: 'removed' },
      { text: ' · 1.2 万 token' },
    ]);
  });

  it('leaves a line that counts no lines whole', () => {
    expect(splitResultFacts('退出码 1')).toEqual([{ text: '退出码 1' }]);
    expect(splitResultFacts('HTTP 200 · 14 KB')).toEqual([
      { text: 'HTTP 200 · 14 KB' },
    ]);
    expect(splitResultFacts('')).toEqual([]);
  });
});
