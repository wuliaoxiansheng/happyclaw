/**
 * What a turn recalls memory by: the words its senders wrote, not the
 * envelope around them. A turn's text is one or more of the host's
 * `<messages>` blocks (src/message-prompt.ts formatMessages; a cold start
 * appends the inputs drained after it), possibly after injected history or
 * checkpoints, which escape their own text. Quoted and forwarded material is
 * someone else's text, and attributes, history and host notes are not what
 * the user is asking about.
 */

/** Only this much of a turn's own text goes to recall. */
export const MAX_MEMORY_RECALL_QUERY_CHARS = 2_000;

const MESSAGE = /<message ([^>]*)>([\s\S]*?)<\/message>/g;
const REFERENCED_BLOCK =
  /<referenced_messages>[\s\S]*?<\/referenced_messages>/g;
const HOST_BLOCKS =
  /<(channel_context|workspace_memory_snapshot|workspace_memory_index)\b[^>]*>[\s\S]*?<\/\1>/g;
/**
 * Heads the block the host appends after an automation's prompt
 * (buildAutomationRunContext); from there on it is the host's text.
 */
const AUTOMATION_CONTEXT_START = '\n[自动化运行上下文]';

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#64;/g, '@')
    .replace(/&amp;/g, '&');
}

function withoutAutomationContext(text: string): string {
  const start = text.indexOf(AUTOMATION_CONTEXT_START);
  return start >= 0 ? text.slice(0, start) : text;
}

export function memoryRecallQuery(turnText: string): string {
  const start = turnText.indexOf('<messages>\n');
  const bodies: string[] = [];
  if (start >= 0) {
    for (const [, attributes, body] of turnText
      .slice(start)
      .matchAll(MESSAGE)) {
      // A forward's text, and the request HappyClaw adds for one, are not
      // the sender's own words.
      if (/\brelation="forwarded_material"/.test(attributes)) continue;
      if (/\bid="[^"]*:default-request"/.test(attributes)) continue;
      const own = withoutAutomationContext(
        unescapeXml(body.replace(REFERENCED_BLOCK, '')),
      ).trim();
      if (own) bodies.push(own);
    }
  }
  const text =
    start >= 0
      ? bodies.join('\n')
      : withoutAutomationContext(turnText).replace(HOST_BLOCKS, '').trim();
  return text.slice(0, MAX_MEMORY_RECALL_QUERY_CHARS);
}
