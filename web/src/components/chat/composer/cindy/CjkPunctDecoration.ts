/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/CjkPunctDecoration.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. HappyClaw keeps lists structural and does not port cindy's
 * plain-text list indent decoration, voice drafts or slash roster coupling, so
 * every CJK-context punctuation character gets its own font span.
 */
/**
 * Tiptap 扩展 —— 给 chat input 里的 CJK 标点(《》「」『』【】())包一层
 * 带显式 CJK 字体栈的 inline span。
 *
 * 解决的问题
 * -----------
 * Chromium 在 contentEditable 里对 Unicode "Common script"字符 (《》「」 等
 * CJK 标点的 script 属性是 Common,不是 Han) 会按相邻字符的 script 来 itemize:
 *   - 序列开头 / 紧挨空格 / 紧挨 Latin 字符的 《 → 当作 Latin script,跳过
 *     字体栈里所有 CJK 字体,命中第一个含 《 字形的 Latin 字体 (Windows 上是
 *     Segoe UI),渲染成 Latin 比例的窄字形 (~7.5px)
 *   - 紧挨汉字的 》 → 当作 CJK script,走 PingFang/YaHei 全角 (~15px)
 *
 * 同一行里就出现了"《 半角、》 全角"的视觉错乱。lang="zh-CN" 在 contentEditable
 * 里被 Chromium 忽略,font-family 栈把 CJK 字体提到最前也无效 —— Chromium 的
 * 这个 itemizer 在 contentEditable 里不老实读 font-family 顺序。
 *
 * 唯一能稳定打断这个 itemization 的办法: 把每个 CJK 标点用一个 <span> 包起来,
 * span 边界强制把 itemization 切开,Chromium 在 span 内部重新 resolve font,
 * 此时显式 font-family 才生效。
 *
 * 边界处理
 * --------
 * - IME 组合期 (用户打 pinyin 还没选字): 保留组合开始前已有的 decoration,
 *   只随 transaction 映射其位置,compositionend 后再按当前 doc 补算。这样既不
 *   重建输入法维护的 DOM,也不会让已有标点在每次组字时切回另一套字形。
 * - 性能: chat input 文本量很小,doc 变化时采用全量重扫;只有组合期为保持
 *   已有 DOM 稳定才映射旧 decoration。
 * - 不污染源数据: decoration 只是渲染层,doc JSON 里没有 span,copy/paste/save
 *   拿到的都是纯文本
 *
 * 已知 trade-off
 * --------------
 * - 光标移到 CJK 标点旁边时 (...|<span>《</span>...) 是 span 边界,Chromium 在
 *   边界处的光标定位有 quirk,可能要按两下方向键才"穿过"标点。这是 Chromium 限
 *   制,无解,大多数用户感知不到
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isCjkContextPunctuation } from './CjkPunctuationUtils';

type CjkDecorationPluginState = {
  decorations: DecorationSet;
  suspendedForComposition: boolean;
};

type CompositionMeta = 'suspend' | 'resume';

const PLUGIN_KEY = new PluginKey<CjkDecorationPluginState>(
  'cjkPunctDecoration',
);

/**
 * 显式 CJK 字体栈。
 *
 * !! 注意 HarmonyOS Sans SC 的位置 !!
 * HarmonyOS Sans SC 的 《 字形被设计成 0.5em 半角宽,跟相邻汉字 1em 全角混排
 * 会出现"《 半角、汉字全角"的视觉错乱。所以这里 HarmonyOS 必须排到 YaHei UI /
 * PingFang 后面,优先让"传统全角风格"的 CJK 字体接管 CJK 标点渲染:
 *   - Mac: PingFang SC 命中,《》 全角一致
 *   - Windows: PingFang / Hiragino 没装跳过,YaHei UI 命中,《》 全角一致
 *   - 其他平台: 兜底到 Noto Sans CJK SC / Source Han / HarmonyOS / sans-serif
 *
 * 不要把 HarmonyOS 提前 —— 提前会让所有 CJK 标点又走它的半角字形,问题复发。
 */
const CJK_FONT_STACK =
  "'PingFang SC','Hiragino Sans GB'," +
  "'Microsoft YaHei UI','Microsoft YaHei'," +
  "'Noto Sans CJK SC','Source Han Sans SC'," +
  "'HarmonyOS Sans SC',sans-serif";

/**
 * 扫描整个 doc, 给所有 CJK 标点位置生成 inline decoration。
 * 用 descendants 遍历所有 text node, 对每个 text node 内的字符做上下文匹配。
 * 注意 from/to 是 doc-level position, 不是 text-node-local offset。
 */
function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    for (let index = 0; index < text.length; index += 1) {
      if (!isCjkContextPunctuation(text, index)) continue;
      const from = pos + index;
      decorations.push(
        Decoration.inline(from, from + 1, {
          // inline style 的优先级比 .ProseMirror 的 css 规则高, 强制覆盖
          style: `font-family:${CJK_FONT_STACK}`,
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const CjkPunctDecoration = Extension.create({
  name: 'cjkPunctDecoration',

  addProseMirrorPlugins() {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<CjkDecorationPluginState>({
        key: PLUGIN_KEY,
        state: {
          init(_config, state: EditorState) {
            return {
              decorations: buildDecorations(state.doc),
              suspendedForComposition: false,
            };
          },
          apply(tr: Transaction, old: CjkDecorationPluginState) {
            const compositionMeta = tr.getMeta(PLUGIN_KEY) as
              | CompositionMeta
              | undefined;
            if (compositionMeta === 'suspend') {
              return { ...old, suspendedForComposition: true };
            }
            // 组字期间只映射已有 decoration,不重建输入法维护的 DOM。
            if (old.suspendedForComposition && compositionMeta !== 'resume') {
              return {
                decorations: tr.docChanged
                  ? old.decorations.map(tr.mapping, tr.doc)
                  : old.decorations,
                suspendedForComposition: true,
              };
            }
            if (compositionMeta !== 'resume' && !tr.docChanged) return old;
            // chat input 文本量很小,全量重扫成本可忽略。
            return {
              decorations: buildDecorations(tr.doc),
              suspendedForComposition: false,
            };
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)?.decorations ?? DecorationSet.empty;
          },
          handleDOMEvents: {
            compositionstart(view) {
              if (resumeTimer !== null) {
                clearTimeout(resumeTimer);
                resumeTimer = null;
              }
              if (!PLUGIN_KEY.getState(view.state)?.suspendedForComposition) {
                view.dispatch(
                  view.state.tr
                    .setMeta(PLUGIN_KEY, 'suspend' satisfies CompositionMeta)
                    .setMeta('addToHistory', false),
                );
              }
              return false;
            },
            compositionend(view) {
              if (resumeTimer !== null) clearTimeout(resumeTimer);
              resumeTimer = setTimeout(() => {
                resumeTimer = null;
                if (view.isDestroyed || view.composing) return;
                if (!PLUGIN_KEY.getState(view.state)?.suspendedForComposition)
                  return;
                view.dispatch(
                  view.state.tr
                    .setMeta(PLUGIN_KEY, 'resume' satisfies CompositionMeta)
                    .setMeta('addToHistory', false),
                );
              }, 0);
              return false;
            },
          },
        },
        view() {
          return {
            destroy() {
              if (resumeTimer !== null) clearTimeout(resumeTimer);
              resumeTimer = null;
            },
          };
        },
      }),
    ];
  },
});
