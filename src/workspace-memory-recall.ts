import crypto from 'node:crypto';

/**
 * Terms for relevance recall over Workspace Memory.
 *
 * The trigram FTS table answers substring searches, but a trigram never
 * matches a two-character Chinese word, and a whole user turn as one phrase
 * matches nothing. Recall therefore keeps a second FTS5 index whose text is
 * pre-split here: Han/Kana/Hangul runs become overlapping bigrams, and
 * everything else stays words for the `porter unicode61` tokenizer. The same
 * split turns a user's message into a handful of OR-ed terms, so bm25 ranks
 * the memories that share the most informative words with it.
 */

const CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_RUN = /[\p{L}\p{N}]+/gu;

/** At most this many terms go into one recall query. */
export const MAX_RECALL_TERMS = 40;

/** Only the start of a long turn is read for terms. */
export const MAX_RECALL_QUERY_CHARS = 2_000;

// Particles and pronouns carry no topic, and a bigram that holds one is
// almost always a split across two words ("部署的" -> "署的", "怎么部署" ->
// "么部"); the listed bigrams are common function words.
const CJK_STOP_CHARS = new Set([...'的了吗呢吧啊呀哦嗯么我你您他她它']);
const CJK_STOP_BIGRAMS = new Set([
  '怎样',
  '为什',
  '这个',
  '那个',
  '一个',
  '这些',
  '那些',
  '一些',
  '可以',
  '就是',
  '没有',
  '不是',
  '是不',
  '一下',
  '现在',
  '然后',
  '因为',
  '所以',
  '如果',
  '但是',
  '还是',
  '已经',
  '这样',
  '需要',
  '看看',
  '是否',
  '能不',
  '不能',
]);
const ENGLISH_STOP_WORDS = new Set(
  (
    'a about after again all also am an and any are as at be because been ' +
    'before being but by can could did do does doing done for from get got ' +
    'had has have having he her here him his how i if in into is it its ' +
    'just let like me more most my no not now of off on once only or other ' +
    'our out over please same she should so some such than thank thanks ' +
    'that the their them then there these they this those through to too ' +
    'up us very was we were what when where which while who why will with ' +
    'would you your'
  ).split(' '),
);

interface RecallToken {
  text: string;
  cjk: boolean;
}

function recallTokens(text: string): RecallToken[] {
  const tokens: RecallToken[] = [];
  for (const [run] of text.normalize('NFKC').matchAll(WORD_RUN)) {
    let latin = '';
    let cjk: string[] = [];
    const flushLatin = () => {
      if (latin) tokens.push({ text: latin.toLowerCase(), cjk: false });
      latin = '';
    };
    const flushCjk = () => {
      for (let i = 0; i + 1 < cjk.length; i++) {
        tokens.push({ text: cjk[i] + cjk[i + 1], cjk: true });
      }
      cjk = [];
    };
    for (const char of run) {
      if (CJK_CHAR.test(char)) {
        flushLatin();
        cjk.push(char);
      } else {
        flushCjk();
        latin += char;
      }
    }
    flushLatin();
    flushCjk();
  }
  return tokens;
}

/** The text a memory is indexed under for recall. */
export function recallIndexText(text: string): string {
  return recallTokens(text)
    .map((token) => token.text)
    .join(' ');
}

/** The distinct informative terms of `text`, in the order they appear. */
export function recallQueryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const token of recallTokens(text.slice(0, MAX_RECALL_QUERY_CHARS))) {
    if (terms.size >= MAX_RECALL_TERMS) break;
    if (token.cjk) {
      if (CJK_STOP_BIGRAMS.has(token.text)) continue;
      if ([...token.text].some((char) => CJK_STOP_CHARS.has(char))) continue;
    } else if (token.text.length < 2 || ENGLISH_STOP_WORDS.has(token.text)) {
      continue;
    }
    terms.add(token.text);
  }
  return [...terms];
}

/**
 * The one token a workspace's recall rows carry in their `scope` column, so
 * a query matches inside its workspace instead of filtering every
 * workspace's matches after the fact.
 */
export function recallScopeToken(workspaceJid: string): string {
  return `ws${crypto.createHash('sha256').update(workspaceJid).digest('hex').slice(0, 24)}`;
}

/**
 * Canonical keys name one durable idea; two keys that differ only by case,
 * width or separators name the same one.
 */
export function normalizeCanonicalKey(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized ? normalized : null;
}
