// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  csvFileName,
  readTable,
  toCsv,
  toTsv,
} from '../src/lib/markdown/table-data';

const table = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = `<table>${html}</table>`;
  return host.querySelector('table')!;
};

describe('table data', () => {
  it('reads header and body cells as text, line breaks kept', () => {
    expect(
      readTable(
        table(
          '<thead><tr><th>方案</th><th>说明</th></tr></thead>' +
            '<tbody><tr><td><strong>窄</strong> selector</td><td>一行<br>两行</td></tr>' +
            '<tr><td>  拆分   store </td><td><a href="#">链接</a></td></tr></tbody>',
        ),
      ),
    ).toEqual([
      ['方案', '说明'],
      ['窄 selector', '一行\n两行'],
      ['拆分 store', '链接'],
    ]);
  });

  it('reads a formula as its TeX source, not KaTeX glyphs twice', () => {
    // The markup rehype-katex renders for `$a^2$`.
    const katex =
      '<span class="katex"><span class="katex-mathml"><math><semantics>' +
      '<mrow><msup><mi>a</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">a^2</annotation>' +
      '</semantics></math></span><span class="katex-html" aria-hidden="true">' +
      '<span class="base"><span class="mord mathnormal">a</span>' +
      '<span class="msupsub"><span class="mord">2</span></span></span></span></span>';
    expect(
      readTable(table(`<tbody><tr><td>面积 ${katex} 平方米</td></tr></tbody>`)),
    ).toEqual([['面积 $a^2$ 平方米']]);
  });

  it('copies as tab-separated rows, quoting a cell with a tab, line break or quote', () => {
    expect(
      toTsv([
        ['a', 'b\tc'],
        ['一行\n两行', '说 "好"'],
        ['甲,乙', '=SUM(A1)'],
      ]),
    ).toBe('a\t"b\tc"\n"一行\n两行"\t"说 ""好"""\n甲,乙\t\'=SUM(A1)');
  });

  it('saves CSV for Excel: BOM, CRLF, quoting, and no formulas', () => {
    expect(
      toCsv([
        ['名称', '金额'],
        ['甲,乙', '-12.5'],
        ['说 "好"', '=SUM(A1)'],
        ['一行\n两行', '+86 138'],
        ['@user', '-x'],
      ]),
    ).toBe(
      '﻿名称,金额\r\n"甲,乙",-12.5\r\n"说 ""好""",\'=SUM(A1)\r\n"一行\n两行",\'+86 138\r\n\'@user,\'-x',
    );
  });

  it('keeps only a whole plain number unquoted after a leading sign', () => {
    const numbers = ['-12.5', '+1,234', '-.5', '+3%', '1e-3', '-2.5E+4', '-0'];
    const formulas = [
      "-2+3+cmd|' /C calc'!A0",
      '+1+HYPERLINK("http://x","y")',
      '-1-1',
      '+86 138',
      '-x',
      '\t=1',
      '\r=1',
    ];
    // The text a spreadsheet gets for the cell, quoting aside.
    const csvCell = (cell: string) =>
      toCsv([[cell]])
        .slice(1)
        .replace(/^"(.*)"$/s, '$1');
    const tsvCell = (cell: string) =>
      toTsv([[cell]]).replace(/^"(.*)"$/s, '$1');
    for (const cell of numbers) {
      expect(csvCell(cell)).toBe(cell);
      expect(tsvCell(cell)).toBe(cell);
    }
    for (const cell of formulas) {
      expect(csvCell(cell).replace(/""/g, '"')).toBe(`'${cell}`);
      expect(tsvCell(cell).replace(/""/g, '"')).toBe(`'${cell}`);
    }
  });

  it('names the file by the local time', () => {
    expect(csvFileName(new Date(2026, 9, 30, 9, 5))).toBe(
      '表格-20261030-0905.csv',
    );
  });
});
