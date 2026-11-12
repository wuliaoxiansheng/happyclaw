/**
 * Prompt-cache effectiveness of one SDK query() call, as one `[cache]` line
 * when the query ends.
 *
 * The rate uses Anthropic usage semantics, where `input_tokens` excludes the
 * cached part: cache_read ÷ (input + cache_creation + cache_read). A gateway
 * that counts cached tokens into `input_tokens` therefore reads low; the four
 * raw numbers are always printed so that case stays recognisable.
 */
import type { SdkResultUsage } from './result-usage.js';

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export class QueryCacheUsage {
  private input = 0;
  private output = 0;
  private cacheCreation = 0;
  private cacheRead = 0;
  private results = 0;

  constructor(private readonly queryRunId?: string) {}

  /** Add the usage of every SDK result message the query produces. */
  observe(sdkMessage: { type: string }): void {
    if (sdkMessage.type !== 'result') return;
    const usage = (sdkMessage as { usage?: SdkResultUsage }).usage;
    if (!usage) return;
    this.results += 1;
    this.input += count(usage.input_tokens);
    this.output += count(usage.output_tokens);
    this.cacheCreation += count(usage.cache_creation_input_tokens);
    this.cacheRead += count(usage.cache_read_input_tokens);
  }

  /** The line for this query, or nothing when it produced no result. */
  finish(): string | undefined {
    if (this.results === 0) return undefined;
    const prompt = this.input + this.cacheCreation + this.cacheRead;
    const rate =
      prompt > 0 ? `${((this.cacheRead / prompt) * 100).toFixed(1)}%` : '-';
    return [
      '[cache]',
      `hit_rate=${rate}`,
      `input=${this.input}`,
      `cache_creation=${this.cacheCreation}`,
      `cache_read=${this.cacheRead}`,
      `output=${this.output}`,
      `results=${this.results}`,
      `queryRunId=${this.queryRunId || '-'}`,
    ].join(' ');
  }
}
