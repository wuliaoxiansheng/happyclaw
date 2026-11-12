/**
 * What the main Agent produced before a Result whose final reply is empty.
 *
 * An empty final reply reaches the user as a card with nothing in it. The
 * shape of the last model response tells the known causes apart: a model
 * that stopped after thinking ("silent stop"), a turn that ended right after
 * a tool call, or a Result with no model response at all.
 */

export type EmptyReplyReason =
  | 'thinking_only'
  | 'tool_only'
  | 'no_assistant'
  | 'other';

const isToolBlock = (type: string): boolean => type.endsWith('tool_use');
const isThinkingBlock = (type: string): boolean =>
  type === 'thinking' || type === 'redacted_thinking';

/**
 * Classify an empty final reply from the content block types of the last
 * model response and the number of responses since the previous Result.
 */
export function classifyEmptyReply(
  lastBlockTypes: readonly string[],
  assistantResponses: number,
): EmptyReplyReason {
  if (assistantResponses === 0) return 'no_assistant';
  if (lastBlockTypes.some(isToolBlock)) return 'tool_only';
  if (lastBlockTypes.includes('text')) return 'other';
  if (lastBlockTypes.some(isThinkingBlock)) return 'thinking_only';
  return 'other';
}

export interface ReplyShape {
  reason: EmptyReplyReason;
  /** Log fields; block types and counts only, never content. */
  summary: string;
}

/**
 * Tracks the top-level model responses between two Results. Claude Code may
 * deliver one response as several AssistantMessages (one per content block)
 * that share the API message id, so blocks are grouped by that id.
 */
export class ReplyShapeTracker {
  private lastMessageId: string | undefined;
  private lastBlockTypes = new Set<string>();
  private assistantResponses = 0;
  private toolUses = 0;

  /** Record one top-level AssistantMessage body (`message.message`). */
  observe(body: { id?: unknown; content?: unknown } | undefined): void {
    const id = typeof body?.id === 'string' && body.id ? body.id : undefined;
    if (id === undefined || id !== this.lastMessageId) {
      this.assistantResponses++;
      this.lastBlockTypes = new Set();
    }
    this.lastMessageId = id;
    if (!Array.isArray(body?.content)) return;
    for (const block of body.content as Array<{ type?: unknown }>) {
      if (typeof block?.type !== 'string') continue;
      this.lastBlockTypes.add(block.type);
      if (isToolBlock(block.type)) this.toolUses++;
    }
  }

  /** The shape so far; starts the next Result's tracking afresh. */
  take(): ReplyShape {
    const lastBlockTypes = [...this.lastBlockTypes];
    const shape: ReplyShape = {
      reason: classifyEmptyReply(lastBlockTypes, this.assistantResponses),
      summary: [
        `assistant_responses=${this.assistantResponses}`,
        `tool_uses=${this.toolUses}`,
        `last_blocks=${lastBlockTypes.join(',') || '-'}`,
      ].join(' '),
    };
    this.lastMessageId = undefined;
    this.lastBlockTypes = new Set();
    this.assistantResponses = 0;
    this.toolUses = 0;
    return shape;
  }
}
