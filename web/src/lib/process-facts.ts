/**
 * What a finished tool call did, as a few words for its row ("+12 −3",
 * "读取 120 行", "退出码 1"). The Runner reads the numbers from the SDK's
 * structured tool result (`ToolResultFacts`); this only phrases them. Every
 * part is optional and a missing one is left out, so a step from an older
 * Runner, or one of a workspace that withholds tool results, has no line.
 */
import { formatSpanZh } from './process-steps';
import type { ToolResultFacts } from './stream-steps';

const SEPARATOR = ' · ';
/** The real minus sign, so "−3" lines up with "+12" and is not a hyphen. */
const MINUS = '−';

function known(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function trimmed(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * "1.2 万", "3.4 千": a count in the shortest form a reader takes in at a
 * glance. Under a thousand it is the number itself.
 */
export function compactCount(value: number): string {
  const n = Math.round(value);
  // A count that would round up to the next unit's 10 reads in that unit.
  if (n >= 99_500_000) return `${trimmed(n / 100_000_000)} 亿`;
  if (n >= 9_950) {
    const tenThousands = n / 10_000;
    return `${tenThousands >= 100 ? Math.round(tenThousands) : trimmed(tenThousands)} 万`;
  }
  if (n >= 1_000) return `${trimmed(n / 1_000)} 千`;
  return String(n);
}

/** "512 B", "14 KB", "1.5 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kilo = bytes / 1024;
  if (kilo < 1024) return `${kilo >= 10 ? Math.round(kilo) : trimmed(kilo)} KB`;
  const mega = kilo / 1024;
  return `${mega >= 10 ? Math.round(mega) : trimmed(mega)} MB`;
}

/** "+12 −3"; a side with nothing in it is left out. */
function diffStat(added?: number, removed?: number): string | null {
  const parts: string[] = [];
  if (known(added) && added > 0) parts.push(`+${Math.round(added)}`);
  if (known(removed) && removed > 0)
    parts.push(`${MINUS}${Math.round(removed)}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

function join(
  parts: ReadonlyArray<string | null | undefined | false>,
): string | null {
  const kept = parts.filter((part): part is string => !!part);
  return kept.length > 0 ? kept.join(SEPARATOR) : null;
}

type AgentFacts = NonNullable<ToolResultFacts['agent']>;

/**
 * A sub-agent's work: what it looked at, searched, changed and ran, the lines
 * it changed, and what it cost. With no breakdown by kind, how many tools it
 * used (that total includes the kinds the breakdown has no name for, so it is
 * not shown beside it).
 */
function describeAgent(agent: AgentFacts): string | null {
  const count = (value: number | undefined, label: string) =>
    known(value) && value > 0 ? `${label} ${Math.round(value)}` : null;
  const breakdown = [
    count(agent.reads, '读'),
    count(agent.searches, '搜'),
    count(agent.edits, '改'),
    count(agent.commands, '命令'),
  ];
  const tools =
    breakdown.some(Boolean) || !known(agent.toolUses) || agent.toolUses <= 0
      ? null
      : `${Math.round(agent.toolUses)} 个工具`;
  return join([
    ...breakdown,
    tools,
    diffStat(agent.added, agent.removed),
    known(agent.tokens) && agent.tokens > 0
      ? `${compactCount(agent.tokens)} token`
      : null,
    formatSpanZh(agent.durationMs) || null,
  ]);
}

/**
 * The line a finished call gets, or `null` when the facts say nothing the row
 * does not already: no facts, a tool this does not know, or a command that
 * succeeded (its exit code is only worth a word when it failed).
 */
export function formatResultFacts(
  toolName: string,
  facts: ToolResultFacts | undefined,
  failed: boolean,
): string | null {
  if (!facts) return null;
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write':
      return join([
        toolName === 'Write' && facts.created && '新建',
        diffStat(facts.added, facts.removed),
      ]);
    case 'Read':
      if (!known(facts.lines)) return null;
      return known(facts.totalLines) && facts.lines < facts.totalLines
        ? `${Math.round(facts.lines)}/${Math.round(facts.totalLines)} 行`
        : `${Math.round(facts.lines)} 行`;
    case 'Glob':
      return known(facts.files) ? `${Math.round(facts.files)} 个文件` : null;
    case 'Grep':
      return join([
        known(facts.matches) && `${Math.round(facts.matches)} 处匹配`,
        // "0 matches" already says there are no files.
        known(facts.files) &&
          facts.matches !== 0 &&
          `${Math.round(facts.files)} 个文件`,
      ]);
    case 'Bash':
      return failed && known(facts.exitCode)
        ? `退出码 ${Math.round(facts.exitCode)}`
        : null;
    case 'WebFetch':
      return join([
        known(facts.httpCode) && `HTTP ${Math.round(facts.httpCode)}`,
        known(facts.bytes) && formatBytes(facts.bytes),
      ]);
    case 'WebSearch':
      return known(facts.searches) && facts.searches > 0
        ? `搜索 ${Math.round(facts.searches)} 次`
        : null;
    case 'Task':
    case 'Agent':
      return facts.agent ? describeAgent(facts.agent) : null;
    default:
      return null;
  }
}

/** What the SDK reports of a running sub-agent (`StreamingTaskRuntimeState.usage`). */
export interface TaskUsageLike {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** "14 个工具 · 1.2 万 token · 46 秒": a running sub-agent's cost so far. */
export function formatTaskUsage(
  usage: TaskUsageLike | undefined,
): string | null {
  if (!usage) return null;
  return formatResultFacts(
    'Agent',
    {
      agent: {
        toolUses: usage.toolUses,
        tokens: usage.totalTokens,
        durationMs: usage.durationMs,
      },
    },
    false,
  );
}

export interface ResultFactsSegment {
  text: string;
  /** The segment counts lines added or removed: the row colours it. */
  tone?: 'added' | 'removed';
}

const DIFF_PART = new RegExp(`([+${MINUS}]\\d+)`);

/** The line cut where it counts lines added ("+12") or removed ("−3"). */
export function splitResultFacts(text: string): ResultFactsSegment[] {
  return text
    .split(DIFF_PART)
    .filter((part) => part !== '')
    .map((part) =>
      DIFF_PART.test(part)
        ? { text: part, tone: part.startsWith('+') ? 'added' : 'removed' }
        : { text: part },
    );
}
