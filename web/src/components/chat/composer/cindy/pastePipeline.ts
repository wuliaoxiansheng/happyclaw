/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/pastePipeline.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. Only the long-paste folding rules are kept; cindy's deep
 * link and absolute-path segmentation have no HappyClaw counterpart.
 *
 * 输入框粘贴长文本时整段折叠为 PastedTextChip(发送时原文内联)。
 */

// ── 长文本折叠阈值 ──
// 行数对齐消息气泡「长消息收起」的手打阈值(14 行)再放宽一档:短粘贴保持
// 直觉(所见即所得),真正的大段 log / diff 才折叠。字符阈值兜住"单行超长"
// (压缩 JSON / base64)。上限:原文会进节点 attrs 并随 toDOM 写进
// data-pasted-text(剪贴板回环依赖它,见 PastedTextChipNode),超大文本挂
// 在 DOM attribute 上代价过高——超限的粘贴不折叠,走默认粘贴(极罕见,
// 编辑器变慢但内容无损)。
export const LONG_PASTE_LINE_THRESHOLD = 24;
export const LONG_PASTE_CHAR_THRESHOLD = 4_000;
export const LONG_PASTE_MAX_CHARS = 2_000_000;

/** 粘贴文本是否该折叠成 PastedTextChip。 */
export function isLongPasteText(text: string): boolean {
  if (text.length > LONG_PASTE_MAX_CHARS) return false;
  if (text.length >= LONG_PASTE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= LONG_PASTE_LINE_THRESHOLD)
      return true;
  }
  return false;
}

/**
 * 剪贴板 HTML 是否带本编辑器自家的 chip 标记(mentionChip / pastedTextChip
 * 的 toDOM 输出)。命中时 handlePaste 应把整个粘贴交回 ProseMirror 默认
 * HTML 解析(parseHTML 原样还原 chip 与周围文本),跳过全部文本变换管线:
 * atom chip 在 text/plain 里没有文本投影,任何「取 text/plain 处理」的分支
 * (长文本折叠 / 深链分段 / 强制纯文本)都会把 chip 的 payload 整个丢掉
 * (review P2:复制「请看 <粘贴文本 chip>」再粘回,折叠原文只存在于 HTML
 * 的 data-pasted-text 里)。标记是本产品 toDOM 专属,外部网页不会携带。
 */
export function htmlCarriesOwnChipMarkup(html: string): boolean {
  return /data-(?:mention-chip|pasted-text-chip)/.test(html);
}

/** 粘贴文本的行数(chip 文案用)。 */
export function countPasteLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
