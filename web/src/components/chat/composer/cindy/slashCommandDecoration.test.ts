/**
 * Source: cindy apps/desktop/src/renderer/__tests__/slashCommandDecoration.test.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6.
 * Dropped: legacy slash-chip migration and Pi `skill:` alias cases.
 */
import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

import {
  createSlashCommandPlugin,
  findSlashCommandMatches,
  replaceSlashCommandRunWithText,
} from './SlashCommandDecoration';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    mentionChip: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        kind: { default: 'file' },
        label: { default: '' },
        path: { default: '' },
      },
    },
  },
});

const p = (...children: PMNode[]) =>
  schema.nodes.paragraph.create(null, children);
const txt = (text: string) => schema.text(text);
const doc = (...paragraphs: PMNode[]) =>
  schema.nodes.doc.create(null, paragraphs);
const command = (name: string) => ({
  kind: 'desktop' as const,
  name,
  description: `${name} command`,
});

function decorationRanges(
  plugin: ReturnType<typeof createSlashCommandPlugin>,
  state: EditorState,
) {
  return (plugin.getState(state)?.decorations.find() ?? []).map((item) => ({
    from: item.from,
    to: item.to,
  }));
}

describe('SlashCommandDecoration', () => {
  it('只装饰边界合法且完整命中的纯文本指令', () => {
    const commands = [command('skill'), command('help')];
    const source = doc(
      p(txt('/skill 参数 /unknown /helpful /HELP')),
      p(txt('正文/help /help')),
    );

    expect(findSlashCommandMatches(source, commands)).toMatchObject([
      { from: 1, to: 7, command: { name: 'skill' } },
      { command: { name: 'help' } },
      { command: { name: 'help' } },
    ]);
  });

  it('palette 选择写入 text node,Backspace 可逐字删除且删坏后 decoration 消失', () => {
    const plugin = createSlashCommandPlugin();
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('/ski'))),
      plugins: [plugin],
    });
    state = state.apply(
      replaceSlashCommandRunWithText(state.tr, schema, 1, 5, 'skill').setMeta(
        'slashCommandDecoration',
        [command('skill')],
      ),
    );

    expect(state.doc.firstChild?.firstChild?.isText).toBe(true);
    expect(state.doc.textContent).toBe('/skill ');
    expect(decorationRanges(plugin, state)).toEqual([{ from: 1, to: 7 }]);

    state = state.apply(state.tr.delete(7, 8));
    expect(state.doc.textContent).toBe('/skill');
    expect(decorationRanges(plugin, state)).toEqual([{ from: 1, to: 7 }]);

    state = state.apply(state.tr.delete(6, 7));
    expect(state.doc.textContent).toBe('/skil');
    expect(decorationRanges(plugin, state)).toEqual([]);
  });
});
