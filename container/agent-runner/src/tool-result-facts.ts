/**
 * What a finished tool call did, as numbers, read from the SDK's structured
 * `tool_use_result` (the tool's own Output object, beside the text the model
 * reads).
 *
 * The facts are the only part of that object the Runner forwards, and they are
 * built field by field from validated numbers and booleans: never a path, file
 * content, command output, URL or any other string, so a Workspace that may not
 * show tool output text can still show how much a tool did.
 */

import type { ToolResultFacts } from './stream-event.types.js';

/** No fact is larger than this; a bigger number is clamped. */
const FACT_MAX = 1_000_000_000;

/** Upper bound on patch lines inspected, so a pathological result stays cheap. */
const PATCH_LINES_MAX = 500_000;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A finite, non-negative whole number, clamped to FACT_MAX; else undefined. */
function count(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, FACT_MAX);
}

/** Like count, but a fractional duration is rounded first. */
function millis(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(Math.round(value), FACT_MAX);
}

/** Lines in a text: a trailing newline does not start another one. */
function lineCount(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    lines++;
  }
  return text.endsWith('\n') ? lines : lines + 1;
}

/** Added / removed lines of a structuredPatch, counted by their +/- prefix. */
function patchCounts(
  patch: unknown,
): { added: number; removed: number } | undefined {
  if (!Array.isArray(patch)) return undefined;
  let added = 0;
  let removed = 0;
  let seen = 0;
  for (const hunk of patch) {
    const lines = isObj(hunk) ? hunk.lines : undefined;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (++seen > PATCH_LINES_MAX) return { added, removed };
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/** `Exit code N` at the head of a failed command's text. */
const EXIT_CODE = /^\s*(?:Error:\s*)?Exit code (\d{1,9})(?!\d)/;

function exitCodeOf(...texts: unknown[]): number | undefined {
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const match = EXIT_CODE.exec(text);
    if (match) return count(Number(match[1]));
  }
  return undefined;
}

/** The first text a `tool_result` block's content carries. */
function headText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      isObj(block) &&
      block.type === 'text' &&
      typeof block.text === 'string'
    ) {
      return block.text;
    }
  }
  return undefined;
}

function agentFacts(result: Obj): ToolResultFacts['agent'] | undefined {
  const stats = isObj(result.toolStats) ? result.toolStats : {};
  const agent: NonNullable<ToolResultFacts['agent']> = {
    toolUses: count(result.totalToolUseCount),
    reads: count(stats.readCount),
    searches: count(stats.searchCount),
    edits: count(stats.editFileCount),
    commands: count(stats.bashCount),
    added: count(stats.linesAdded),
    removed: count(stats.linesRemoved),
    tokens: count(result.totalTokens),
    durationMs: millis(result.totalDurationMs),
  };
  return compact(agent);
}

/** The object without its undefined fields, or undefined if nothing is left. */
function compact<T extends object>(facts: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

function structuredFacts(
  toolName: string,
  result: Obj,
): ToolResultFacts | undefined {
  switch (toolName) {
    case 'Read': {
      const file = isObj(result.file) ? result.file : undefined;
      if (!file) return undefined;
      return compact({
        lines: count(file.numLines),
        totalLines: count(file.totalLines),
      });
    }
    case 'Edit':
    case 'MultiEdit': {
      // A staged edit was held back for review: the file is unchanged.
      if (result.staged === true) return undefined;
      const changed = patchCounts(result.structuredPatch);
      return changed && { added: changed.added, removed: changed.removed };
    }
    case 'Write': {
      if (result.type === 'create') {
        const added =
          typeof result.content === 'string'
            ? Math.min(lineCount(result.content), FACT_MAX)
            : undefined;
        return compact({ created: true, added });
      }
      if (result.type === 'update') {
        const changed = patchCounts(result.structuredPatch);
        return compact({
          created: false,
          added: changed?.added,
          removed: changed?.removed,
        });
      }
      return undefined;
    }
    case 'Glob':
      return compact({
        files: count(result.numFiles),
        matches: count(result.totalMatches),
        durationMs: millis(result.durationMs),
      });
    case 'Grep': {
      const files = count(result.numFiles);
      const lineMatches =
        result.mode === undefined || result.mode === 'content'
          ? count(result.numLines)
          : undefined;
      return compact({
        matches: count(result.numMatches) ?? lineMatches,
        files: files !== undefined && files > 0 ? files : undefined,
      });
    }
    case 'WebFetch':
      return compact({
        httpCode: count(result.code),
        bytes: count(result.bytes),
        durationMs: millis(result.durationMs),
      });
    case 'WebSearch': {
      const seconds = result.durationSeconds;
      return compact({
        searches: count(result.searchCount),
        durationMs:
          typeof seconds === 'number' && Number.isFinite(seconds)
            ? millis(seconds * 1000)
            : undefined,
      });
    }
    case 'Agent':
    case 'Task': {
      const agent = agentFacts(result);
      return agent && { agent };
    }
    default:
      return undefined;
  }
}

/**
 * The facts of one finished tool call, or undefined when there are none.
 *
 * @param toolName    the name of the tool_use the result answers
 * @param toolUseResult the SDK message's `tool_use_result`: an object for a
 *   tool that succeeded, a string (`Error: ...`) when it failed, absent for a
 *   call run inside a sub-agent. Pass undefined when one message carries
 *   several results and it cannot be told whose it is.
 * @param block       the `tool_result` block's `is_error` and content: only a
 *   failed command's text is read for its exit code, never a successful one's
 */
export function extractToolResultFacts(
  toolName: string | undefined,
  toolUseResult: unknown,
  block: { isError?: boolean; content?: unknown } = {},
): ToolResultFacts | undefined {
  if (!toolName) return undefined;
  const facts: ToolResultFacts = {};
  if (isObj(toolUseResult)) {
    Object.assign(facts, structuredFacts(toolName, toolUseResult));
  }
  if (toolName === 'Bash' && block.isError === true) {
    // The SDK reports no exit code field: a failed command says it in text.
    const exitCode = exitCodeOf(toolUseResult, headText(block.content));
    if (exitCode !== undefined) facts.exitCode = exitCode;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}
