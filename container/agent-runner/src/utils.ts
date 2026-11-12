/**
 * Utility functions for HappyClaw Agent Runner.
 *
 * Pure utility functions with no side effects or state dependencies.
 */

/**
 * Shorten a string to maxLen, appending "..." if truncated.
 */
export function shorten(input: string, maxLen = 180): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}...`;
}

/**
 * Recursively redact sensitive fields (tokens, passwords, API keys, etc.)
 * from an object. Limits recursion depth to 3 levels.
 */
export function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (input == null) return input;
  if (
    typeof input === 'string' ||
    typeof input === 'number' ||
    typeof input === 'boolean'
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        /(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * Strip well-known secret patterns embedded inside tool input strings before
 * they ride out as `toolInputSummary` to every connected WebSocket client and
 * the persisted stream-event log.
 *
 * `redactSensitive` only matches sensitive *keys* — that's not enough for
 * Bash/curl/WebFetch where the actual command/url string carries a Bearer
 * token, api_key=, sk-…, ghp_…, etc. as inline content. We string-replace
 * those before truncating to 180 chars.
 */
export function redactInlineSecrets(value: string): string {
  // 长度兜底：超过 32KB 直接整段标记，跳过昂贵的多 regex 扫描。攻击者
  // 若用 prompt-injection 让 agent 跑出 60KB+ 的 toolInput（接近 schema
  // 上限），原 regex 在 lazy-prefix 下退化为 O(n^2)（10k char ≈ 16ms,
  // 60k ≈ 600ms），可被多次链式 tool-call 钉住单 agent CPU。
  if (value.length > 32 * 1024) {
    return '[REDACTED LARGE INPUT]';
  }
  return (
    value
      // OAuth bearer (case-insensitive)
      .replace(/\bbearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
      // basic auth in URLs (https://user:pass@host) — extend beyond http(s)
      // to cover postgres / mongodb / redis / mysql / ftp / ssh / git etc.
      // The DSN form `<scheme>://user:pass@host/...` is universal; restrict
      // the scheme to a reasonable identifier shape to avoid colon-rich text.
      .replace(
        /(\b[a-z][a-z0-9+.\-]{1,15}:\/\/[^\s\/:@]+:)[^\s@\/?#]+(@)/gi,
        '$1[REDACTED]$2',
      )
      // key=value / key:value with explicit secret-shaped key. Anchor 不再
      // 用 lazy `[A-Za-z0-9_]*?` 兜底（O(n^2) ReDoS 源头），改成显式枚举
      // 常见前缀 + 限定长度。截止字符增加 ; , 拦多 cookie 行。
      .replace(
        /(?:^|[^A-Za-z0-9])((?:gh|github|gitlab|npm|access|refresh|auth|api)[_-]token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|x-api-key|authorization|password|secret|cookie|token|pat)\s*[:=]\s*["']?[^"'\s;,&]+/giu,
        (m, k) => {
          const prefix = m.startsWith(k) ? '' : m[0];
          return `${prefix}${k}=[REDACTED]`;
        },
      )
      // CLI 形态 `--token <value>` / `--api-key value` / `-H 'Authorization: …'`
      .replace(
        /(--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|x-api-key))\s+(?!--)\S{4,}/gi,
        '$1 [REDACTED]',
      )
      // 主流厂商 token 前缀
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
      .replace(/\bglpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED]')
      .replace(/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/g, '[REDACTED]')
      .replace(/\bAIza[0-9A-Za-z_\-]{35}/g, '[REDACTED]')
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]')
      // private key / pem 头标识，整段一路擦到 END 标记
      .replace(
        /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
  );
}

/**
 * String fields that say what a tool call is about, best first: a shell
 * command, a search query, the file a read or edit targets, a search pattern
 * (before the directory it runs in), a URL (before the prompt asked of it).
 */
const INPUT_SUMMARY_KEYS: readonly string[] = [
  'command',
  'query',
  'file_path',
  'notebook_path',
  'pattern',
  'path',
  'url',
  'prompt',
  'name',
];

function formatInputSummary(key: string, value: string): string {
  return `${key}: ${shorten(redactInlineSecrets(value.trim()))}`;
}

/**
 * Summarize tool input for display in stream events.
 * Extracts key fields (command, query, file_path, pattern, url, etc.) or
 * serializes the object.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;

  if (typeof input === 'string') {
    return shorten(redactInlineSecrets(input.trim()));
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of INPUT_SUMMARY_KEYS) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return formatInputSummary(key, value);
      }
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      // Skip empty or trivial objects (e.g. {} at content_block_start)
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(redactInlineSecrets(json));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** How much of a streamed tool input is scanned for an early summary. */
export const EARLY_INPUT_SCAN_MAX = 4096;

/** The end of the JSON string that opens at `from`, or undefined if unclosed. */
function jsonStringEnd(s: string, from: number): number | undefined {
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '"') return i + 1;
  }
  return undefined;
}

/** The end of the JSON value that starts at `from`, or undefined if cut off. */
function jsonValueEnd(s: string, from: number): number | undefined {
  const first = s[from];
  if (first === '"') return jsonStringEnd(s, from);
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        const end = jsonStringEnd(s, i);
        if (end === undefined) return undefined;
        i = end - 1;
      } else if (c === '{' || c === '[') {
        depth++;
      } else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return undefined;
  }
  // A number or literal is only whole once a delimiter follows it.
  let i = from;
  while (i < s.length && !/[,}\]\s]/.test(s[i])) i++;
  return i < s.length ? i : undefined;
}

function skipJsonSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/**
 * The summary a tool call's input already settles on, read from the first
 * `EARLY_INPUT_SCAN_MAX` characters of its still-streaming JSON: the
 * best-ranked summary key whose string value has arrived whole. A value cut
 * off mid-string (or mid-escape) is never used and values of other types are
 * skipped, so the result is one a full parse of the same input could give.
 * Undefined while nothing usable has arrived. A key that streams later can
 * still outrank the one found; the complete input settles that.
 */
export function extractEarlyToolInputSummary(
  partialJson: string,
): string | undefined {
  const s =
    partialJson.length > EARLY_INPUT_SCAN_MAX
      ? partialJson.slice(0, EARLY_INPUT_SCAN_MAX)
      : partialJson;
  let i = skipJsonSpace(s, 0);
  if (s[i] !== '{') return undefined;
  i++;
  let best: { rank: number; key: string; value: string } | undefined;
  for (;;) {
    i = skipJsonSpace(s, i);
    if (i >= s.length) break;
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] !== '"') break;
    const keyEnd = jsonStringEnd(s, i);
    if (keyEnd === undefined) break;
    let key: unknown;
    try {
      key = JSON.parse(s.slice(i, keyEnd));
    } catch {
      break;
    }
    i = skipJsonSpace(s, keyEnd);
    if (s[i] !== ':') break;
    i = skipJsonSpace(s, i + 1);
    if (i >= s.length) break;
    const valueEnd = jsonValueEnd(s, i);
    if (valueEnd === undefined) break;
    const rank = typeof key === 'string' ? INPUT_SUMMARY_KEYS.indexOf(key) : -1;
    if (rank >= 0 && s[i] === '"' && (!best || rank < best.rank)) {
      try {
        const value: unknown = JSON.parse(s.slice(i, valueEnd));
        if (typeof value === 'string' && value.trim()) {
          best = { rank, key: key as string, value };
        }
      } catch {
        // A malformed string is not a summary.
      }
    }
    i = valueEnd;
  }
  return best && formatInputSummary(best.key, best.value);
}

/**
 * Summarize a tool_result block's content for streaming display.
 *
 * The SDK delivers tool results as either a plain string or an array of content
 * blocks ({type:'text'|'image'|...}). We flatten the text, redact inline secrets,
 * and clamp the length so the trace stays readable without dumping a 10K-line
 * bash output into the card. Returns undefined for empty / non-textual results.
 */
export function summarizeToolResult(
  content: unknown,
  maxLen = 400,
): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: string };
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return shorten(redactInlineSecrets(trimmed), maxLen);
}

/**
 * Extract a skill name from Skill tool input.
 * Tries skillName, skill, name, command fields, then regex-matches leading slashes.
 */
export function extractSkillName(
  toolName: unknown,
  input: unknown,
): string | undefined {
  if (toolName !== 'Skill') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const raw =
    (typeof obj.skillName === 'string' && obj.skillName) ||
    (typeof obj.skill === 'string' && obj.skill) ||
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.command === 'string' && obj.command) ||
    '';
  if (!raw) return undefined;
  const matched = raw.match(/\/([A-Za-z0-9._-]+)/);
  if (matched && matched[1]) return matched[1];
  return raw.replace(/^\/+/, '').trim() || undefined;
}

/**
 * Sanitize a string for use as a filename.
 * Lowercases, replaces non-alphanumeric characters with hyphens, trims, and limits length.
 */
export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Generate a fallback conversation archive filename based on current time.
 */
export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * 判定一个 subtype=success 的 SDK result 是否为「上游断流截断」的合成结果。
 *
 * 指纹来源（实测事故）：第三方网关在长文本生成中途断流时，SDK 收不到终结帧
 * （message_delta/message_stop + usage），只能把已缓冲的 partial 文本按
 * subtype=success 收口，此时 result.usage 的 input/output tokens 均为 0——
 * 而健康 turn 的 result.usage 恒为正（query 级累计值，且真实 turn 必产生
 * output tokens）。正文非空 + usage 双零 = 截断合成结果的确定性指纹。
 *
 * 保守起见 usage 缺失不判定为截断（避免误伤未知的 SDK 变体）；误报的代价是
 * 多发一次"请继续"的续写 turn（有次数上限），漏报的代价是半截回复被当成
 * 完整回复交付。
 */
export function isSuspectTruncatedStreamResult(
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
  resultTextLength: number,
): boolean {
  if (resultTextLength <= 0) return false;
  if (!usage) return false;
  return (usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0;
}

const STALE_BACKGROUND_WAIT_PATTERNS = [
  /等待其余\s*\d+\s*个\s*(?:Agent|agent|任务|后台任务)/u,
  /\d+\s*\/\s*\d+\s*完成[\s\S]{0,80}等待/u,
  /后台\s*(?:Agent|agent|任务)[\s\S]{0,80}(?:完成后|结束后)[\s\S]{0,80}(?:继续汇总|自动唤醒|继续)/u,
  /(?:任务|Agent|agent)[\s\S]{0,80}(?:运行中|还在跑|尚未完成)[\s\S]{0,80}(?:继续汇总|等待)/u,
  /(?:I'll|I will)\s+wait\s+for\s+the\s+(?:other|remaining)\s+\d+\s+(?:agents|tasks)/iu,
  /(?:waiting|wait)\s+for\s+(?:the\s+)?(?:other|remaining)\s+\d+\s+(?:agents|tasks)/iu,
];

/**
 * Background task completion can race with model text generation. The SDK may
 * deliver all task notifications, but the model can still finish with a stale
 * progress update ("1/6 done, waiting for the rest"). Only use this predicate
 * after this query has already emitted a result with pending background tasks.
 */
export function isStaleBackgroundWaitReply(
  text: string | null | undefined,
): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  return STALE_BACKGROUND_WAIT_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}

export function shouldForceBackgroundTaskSummary(params: {
  emitOutput: boolean;
  sawPendingBackgroundTasks: boolean;
  pendingBgTasks: number;
  finalText: string | null | undefined;
  attempts: number;
  maxAttempts: number;
}): boolean {
  if (!params.emitOutput) return false;
  if (!params.sawPendingBackgroundTasks) return false;
  if (params.pendingBgTasks !== 0) return false;
  if (params.attempts >= params.maxAttempts) return false;
  return isStaleBackgroundWaitReply(params.finalText);
}

export function buildBackgroundTaskSummaryPrompt(): string {
  return [
    '<system-reminder>',
    'All background Task agents for the previous user request have now completed.',
    'Your previous draft still said you were waiting for remaining agents, so it was stale.',
    'Do not send another progress update. Use the task-notification results already present in this conversation and produce the final user-facing synthesis now.',
    'If you wrote scratch files for any cluster, read them only if needed. Otherwise summarize directly from the completed task notifications.',
    '</system-reminder>',
  ].join('\n');
}

/** AssistantTextTracker 处理的 content block 最小形状（SDK assistant 消息的 content 数组元素）。 */
export interface AssistantContentBlock {
  type: string;
  text?: string;
}

/**
 * Turn 内 assistant 文本按模型响应边界分类。
 *
 * 只要一次模型响应含 top-level tool_use，它的所有 text 都是过程旁白——无论
 * block 顺序是 [text, tool_use]、[tool_use, text]，或 text/tool 交错。只有
 * 完全不含 top-level tool_use 的响应，其完整 text 才能成为 SDK Result 缺失时
 * 的候选答案。
 *
 * Claude Code 把一次响应按内容块拆成多条 AssistantMessage（共享 message.id），
 * 旁白 text 帧会先于同一响应的 tool_use 帧到达，因此以 message.id 为原子单位：
 * 同 id 的 text 按到达顺序拼接，一旦该 id 出现 tool_use，候选退回到该响应开始
 * 前的值。没有 message.id 时每条 AssistantMessage 自成一个响应。
 */
export class AssistantTextTracker {
  private answerCandidate = '';
  /** The response whose frames are still arriving. */
  private response:
    | { id: string; text: string; hasTool: boolean; candidateBefore: string }
    | undefined;

  /**
   * 处理一条 top-level AssistantMessage 的 content blocks；`messageId` 是其
   * API message.id。返回该帧是否含文本（调用方据此更新 canonical uuid）。
   */
  addContentBlocks(
    blocks: AssistantContentBlock[],
    messageId?: string,
  ): boolean {
    let frameText = '';
    let frameHasTool = false;
    for (const block of blocks) {
      if (
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text
      ) {
        frameText += block.text;
      } else if (block.type === 'tool_use') {
        frameHasTool = true;
      }
    }
    if (!messageId || this.response?.id !== messageId) {
      this.response = {
        id: messageId ?? '',
        text: '',
        hasTool: false,
        candidateBefore: this.answerCandidate,
      };
    }
    const response = this.response;
    response.text += frameText;
    response.hasTool ||= frameHasTool;
    this.answerCandidate =
      !response.hasTool && response.text.trim()
        ? response.text
        : response.candidateBefore;
    return frameText.length > 0;
  }

  /**
   * 非空 SDK Result 是唯一权威。只有 SDK Result 缺失时，才回退到最近一条
   * 完全不含 top-level tool_use 的 AssistantMessage；过程旁白绝不兜底成
   * 最终答复。
   */
  pickFinalText(sdkResult: string | null | undefined): string | null {
    if (sdkResult && sdkResult.trim()) return sdkResult;
    return this.answerCandidate.trim() ? this.answerCandidate : null;
  }

  /** mid-query follow-up 产生第二条 result 时与 turnId 一起重置。 */
  reset(): void {
    this.answerCandidate = '';
    this.response = undefined;
  }
}

/**
 * 解析当前时区名（IANA）。与主服务 src/config.ts 的 TIMEZONE 同一条 fallback 链
 * （agent-runner 是独立项目，无法 import src/，故在此复刻）。容器模式下 entrypoint
 * 注入了 TZ；host 模式可能没设 TZ，退回系统解析的时区，最后兜底 Asia/Shanghai。
 */
export function currentTimeZone(): string {
  return (
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'Asia/Shanghai'
  );
}

interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm:ss
  offset: string; // +08:00 / -05:00 / +00:00
}

function localDateTimeParts(d: Date, tz: string): LocalParts {
  const dtParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => dtParts.find((p) => p.type === t)?.value ?? '';
  // en-CA + hour12:false 在午夜可能给出 '24'，归一到 '00'。
  let hour = get('hour');
  if (hour === '24') hour = '00';

  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const offsetName =
    offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = offsetName.match(/GMT([+-]\d{2}:?\d{2})/);
  let offset = m ? m[1] : '+00:00';
  if (offset.length === 5) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`; // +0800 -> +08:00

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}:${get('second')}`,
    offset,
  };
}

/**
 * 当前时刻的本地 ISO-8601-with-offset 串 + 时区名，供注入 agent 上下文做相对时间推理。
 * 形如：2026-06-12T10:50:00+08:00 (Asia/Shanghai)
 */
export function formatLocalNow(d: Date = new Date()): string {
  const tz = currentTimeZone();
  const { date, time, offset } = localDateTimeParts(d, tz);
  return `${date}T${time}${offset} (${tz})`;
}

/**
 * 把一个 UTC ISO 串（如存储层的 next_run）转成本地时区的可读串，供回执/列表展示。
 * 形如：2026-06-12 10:50:00 (+08:00)。空/非法输入分别返回 'N/A' / 原样。
 */
export function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = currentTimeZone();
  const { date, time, offset } = localDateTimeParts(d, tz);
  return `${date} ${time} (${offset})`;
}
