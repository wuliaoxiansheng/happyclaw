/**
 * A rendered Markdown table as plain cells, for copying into a spreadsheet
 * (tab-separated) or saving as CSV.
 */

/**
 * A cell's text with `<br>` as a line break and whitespace runs collapsed.
 * Math is its TeX source between `$`, as the reply wrote it: KaTeX renders
 * a formula as MathML and HTML side by side, whose text read together is
 * the formula twice over, glyph by glyph.
 */
function cellText(cell: Element): string {
  let text = '';
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent ?? '';
      else if (child instanceof Element) {
        if (child.tagName === 'BR') text += '\n';
        else if (child.classList.contains('katex')) {
          const tex = child.querySelector(
            'annotation[encoding="application/x-tex"]',
          )?.textContent;
          if (tex != null) text += `$${tex.trim()}$`;
          else {
            const html = child.querySelector('.katex-html');
            if (html) walk(html);
          }
        } else walk(child);
      }
    }
  };
  walk(cell);
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

/** Header and body rows, each cell as text. */
export function readTable(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll('tr'), (row) =>
    Array.from(row.querySelectorAll('th, td'), cellText),
  ).filter((row) => row.length > 0);
}

/** A number as a spreadsheet reads it: `-12.5`, `+1,234`, `1e-3`, `50%`. */
const PLAIN_NUMBER = /^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i;

/**
 * A cell a spreadsheet would run as a formula (`=…`, `@…`, a leading tab or
 * carriage return, or a `+`/`-` that does not start a plain number) is kept
 * as text with a leading apostrophe. `-2+3+cmd|…` starts with a number and
 * is still a formula, so the whole cell must be the number.
 */
function inert(cell: string): string {
  return /^[=@\t\r]/.test(cell) ||
    (/^[+-]/.test(cell) && !PLAIN_NUMBER.test(cell))
    ? `'${cell}`
    : cell;
}

/**
 * Rows of `separator`-joined cells, quoting (RFC 4180) a cell that holds the
 * separator, a quote or a line break.
 */
function delimited(
  rows: readonly (readonly string[])[],
  separator: string,
  newline: string,
): string {
  const special = new RegExp(`["${separator}\r\n]`);
  const field = (cell: string) => {
    const safe = inert(cell);
    return special.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((row) => row.map(field).join(separator)).join(newline);
}

/**
 * Tab-separated rows: Excel, Numbers, Google Sheets and Feishu sheets split
 * a paste of these into cells, and keep a quoted cell's tab or line break
 * inside the cell.
 */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return delimited(rows, '\t', '\n');
}

/** CSV (RFC 4180, CRLF) with a byte-order mark so Excel reads it as UTF-8. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return '﻿' + delimited(rows, ',', '\r\n');
}

/** `表格-20261030-1542.csv`, in local time. */
export function csvFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `表格-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}
