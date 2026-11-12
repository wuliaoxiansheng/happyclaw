import { MEMORY_WRITE_TOOLS } from '@/lib/process-visibility';
import type { StreamingStep } from '@/lib/stream-steps';

export interface MemoryReceipt {
  id: string;
  title: string | null;
  /** Saved as a proposal the workspace owner still has to confirm. */
  proposed: boolean;
}

const RESULT = /"result":"(remembered|updated|proposed)"/;
const ID = /"id":"([^"\\]+)"/;
const TITLE = /"title":("(?:[^"\\]|\\.)*")/;

/**
 * A memory write's result, read from the start of its text the step keeps
 * (the Runner's workspaceMemoryWriteResult puts `result`, `id` and `title`
 * first, so a bounded preview holds them; a title cut off by the bound is
 * left out).
 */
function readReceipt(preview: string | undefined): MemoryReceipt | null {
  if (!preview) return null;
  const result = RESULT.exec(preview)?.[1];
  const id = ID.exec(preview)?.[1];
  if (!result || !id) return null;
  let title: string | null = null;
  const quoted = TITLE.exec(preview)?.[1];
  if (quoted) {
    try {
      title = JSON.parse(quoted) as string;
    } catch {
      title = null;
    }
  }
  return { id, title: title?.trim() || null, proposed: result === 'proposed' };
}

/** The memories a reply's successful write calls left, last write per item. */
export function memoryReceipts(
  steps: readonly StreamingStep[],
): MemoryReceipt[] {
  const receipts = new Map<string, MemoryReceipt>();
  for (const step of steps) {
    if (
      step.kind !== 'tool' ||
      step.status !== 'done' ||
      !MEMORY_WRITE_TOOLS.has(step.toolName ?? '')
    ) {
      continue;
    }
    const receipt = readReceipt(step.resultPreview);
    if (!receipt) continue;
    receipts.delete(receipt.id);
    receipts.set(receipt.id, receipt);
  }
  return [...receipts.values()];
}
