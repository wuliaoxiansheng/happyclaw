export type DiffLineKind =
  | 'meta' // diff --git, index, ---, +++, mode and rename headers
  | 'hunk' // @@ -a,b +c,d @@
  | 'add'
  | 'del'
  | 'context'
  | 'note'; // \ No newline at end of file

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Classify the lines of a unified diff. Hunk bodies are tracked by the line
 * counts in their header, so a removed line that reads "--- x" or an added
 * "+++ y" is never mistaken for a file header.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const raw = diff.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const lines: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of raw) {
    if (oldLeft > 0 || newLeft > 0) {
      const marker = text[0];
      if (marker === '+') {
        newLeft--;
        lines.push({ kind: 'add', text });
        continue;
      }
      if (marker === '-') {
        oldLeft--;
        lines.push({ kind: 'del', text });
        continue;
      }
      if (marker === ' ' || text === '') {
        oldLeft--;
        newLeft--;
        lines.push({ kind: 'context', text });
        continue;
      }
      if (marker !== '\\') {
        oldLeft = 0;
        newLeft = 0;
      }
    }
    if (text.startsWith('\\')) {
      lines.push({ kind: 'note', text });
      continue;
    }
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      lines.push({ kind: 'hunk', text });
      continue;
    }
    lines.push({ kind: 'meta', text });
  }
  return lines;
}
