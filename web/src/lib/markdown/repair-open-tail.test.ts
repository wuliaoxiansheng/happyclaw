import { describe, expect, it } from 'vitest';
import { repairOpenTail } from './repair-open-tail';

describe('repairOpenTail', () => {
  it.each([
    // Emphasis still open on the last line closes where the text ends.
    ['**粗体', '**粗体**'],
    ['这是**重点内容', '这是**重点内容**'],
    ['a **bold text ', 'a **bold text** '],
    ['x __strong', 'x __strong__'],
    ['~~删除', '~~删除~~'],
    ['**注意：**正文 **再', '**注意：**正文 **再**'],
    ['`code` 和 **粗', '`code` 和 **粗**'],
    ['# **标题', '# **标题**'],
    ['- 第一项\n- **第二', '- 第一项\n- **第二**'],
    ['first line\nsecond **bold', 'first line\nsecond **bold**'],
    ['- **a\n\n- b **c', '- **a\n\n- b **c**'],
    ['链接 https://a.com/_x_ 后 **粗', '链接 https://a.com/_x_ 后 **粗**'],
    // Next to curly quotes, as remark-cjk-friendly reads them.
    ['精密绝伦的**“微观光学实验', '精密绝伦的**“微观光学实验**'],
    ['的**“引号”', '的**“引号”**'],
    ['的**“引号”**，再**“另一', '的**“引号”**，再**“另一**'],
    // Display math holds no delimiters; a single `$` is text.
    ['$$x^{**}$$ and **粗', '$$x^{**}$$ and **粗**'],
    ['原价$20，**限时$10', '原价$20，**限时$10**'],
    ['`a$b` 文本 **粗体$c', '`a$b` 文本 **粗体$c**'],
    ['收费 $$ 很贵，参见[文档](htt', '收费 $$ 很贵，参见文档'],
    // A single `*` or `_` is passed over, not closed.
    ['a *b **粗体', 'a *b **粗体**'],
    ['**a _b', '**a _b**'],
    ['**粗*斜*体', '**粗*斜*体**'],
    // A closer being written is completed, not doubled.
    ['**粗体*', '**粗体**'],
    ['~~删除~', '~~删除~~'],
    // An opener with nothing after it yet does not show.
    ['前文 **', '前文 '],
    ['这是**', '这是'],
    ['**', ''],
    ['**粗体** 然后 **', '**粗体** 然后 '],
    // A half-written link shows its text; a half-written image nothing.
    ['参见[文档](https://exa', '参见文档'],
    ['[文档](', '文档'],
    ['[**粗**](htt', '**粗**'],
    ['图片：![示意图](https://img.example.com/a', '图片：'],
    ['图片：![示意', '图片：'],
    ['图片：![示意图]', '图片：'],
  ])('%j shows as %j', (block, shown) => {
    expect(repairOpenTail(block)).toBe(shown);
  });

  it.each([
    // Complete or ambiguous emphasis.
    '**粗体**',
    '***粗斜体',
    '* item',
    '** 空格后',
    'a ** b',
    '**a *b**',
    // Code: an open fence, an inline code span still open or complete.
    '```js\nconst a = **b',
    '`a **b',
    '`a **b` c',
    'text `a\nb **c',
    // An opener on an earlier line of the paragraph.
    '**first line\nsecond',
    '**第一行\n第二行**继续',
    // Closed next to quotes and full-width punctuation: nothing to add.
    '的**“引号”**，',
    '有**“七种颜色”**呢？',
    '**注意：**正文',
    '前文**重点；**\n下一行',
    '；**\n下一行',
    // Whether `_` closes depends on what follows it.
    '__强调_',
    // A single `*` or `_` is never closed: footnote marks, `(*)`, `*args`,
    // math, or emphasis inside the bold it would cross.
    '注*：本数据',
    'see note (*) below',
    'call foo_bar(*args',
    'the optimal $x^*$ is attained',
    '$\\hat{x}_{t}$ is the estimate',
    'see *it',
    'see _it',
    '**a *b',
    '**粗 *斜',
    '这是*',
    // Display math still being written runs to the end.
    '$$\nx^{**} 和 **粗',
    '收费 $$ 很贵，**注意',
    // Not emphasis at all.
    'snake_case_name',
    'foo_',
    '变量_',
    '2*3 = 6',
    '2*',
    '约 3~5 天',
    '约 3~',
    'text \\*escaped',
    'https://example.com/_private',
    '[notes]',
    '[文字](https://example.com "标题',
    '`[a](b`',
    '感叹号!',
    // The block ends a line: nothing is being written on it.
    'para **bold\n',
    '',
  ])('%j stays as written', (block) => {
    expect(repairOpenTail(block)).toBe(block);
  });
});
