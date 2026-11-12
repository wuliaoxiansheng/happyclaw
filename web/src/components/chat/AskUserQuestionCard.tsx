import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StepQuestion } from '../../lib/stream-steps';
import { useAskAnswersStore, type AskProgress } from '../../stores/ask-answers';
import { useShellStore } from '../../stores/shell';

const NO_PROGRESS: AskProgress = { picked: [], own: [], index: 0 };

/**
 * AskUserQuestion options. The runner has no interactive answer channel, so
 * the reply is the user's next message: the card collects the answers and
 * fills them into the composer for the user to edit and send. Filling again
 * replaces what the card filled before, while the composer still holds it.
 * The answers so far live in a store by `toolUseId`, so they survive the
 * card being rendered anew once the reply settles.
 *
 * - One single-choice question: a tap fills the composer right away.
 * - Several questions: one at a time; a single choice moves on by itself,
 *   a multi-select waits for 下一题. 填入输入框 writes every answer, each
 *   under its question, so the reply says which answer is for what.
 * - 其他… takes an answer of the reader's own: for a single choice it
 *   replaces the option, for a multi-select it is one more.
 * - Keys, while the card or 其他… has focus: 1–9 pick an option (not in
 *   其他…), Enter goes on to the next question, or fills the composer on the
 *   last. On a button Enter is the button's own.
 */
export function AskUserQuestionCard({
  toolUseId,
  questions,
}: {
  toolUseId: string;
  questions: readonly StepQuestion[];
}) {
  const { picked, own, index } =
    useAskAnswersStore((s) => s.progress[toolUseId]) ?? NO_PROGRESS;
  const filled = useShellStore((s) => s.composerFills[toolUseId]);
  const save = (next: Partial<AskProgress>) =>
    useAskAnswersStore
      .getState()
      .setProgress(toolUseId, { picked, own, index, ...next });
  const setIndex = (next: number) => save({ index: next });
  const cardRef = useRef<HTMLDivElement>(null);
  // Moving to another question unmounts the focused option: the card takes
  // focus instead, so the keys keep working.
  const keepFocus = useRef(false);
  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) {
      card.focus({ preventScroll: true });
    }
  }, [index]);

  if (questions.length === 0) return null;
  const total = questions.length;
  const at = Math.min(index, total - 1);
  const q = questions[at];
  const chosen = picked[at] ?? [];
  const quick = total === 1 && !q.multiSelect;
  const answers = questions.map((question, i) =>
    mergeAnswer(picked[i] ?? [], own[i] ?? '', question.multiSelect),
  );
  const reply = composeReply(questions, answers);
  const answered = answers.filter((a) => a.length > 0).length;
  const isFilled = filled === reply;

  const fill = (text: string) => {
    if (!text || text === filled) return;
    useShellStore.getState().requestComposerDraft(text, toolUseId);
  };

  // Questions can grow while the call streams in; answers follow them.
  const withAt = <T,>(list: readonly T[], value: T, empty: T) =>
    questions.map((_, i) => (i === at ? value : (list[i] ?? empty)));

  const choose = (label: string) => {
    const mine = chosen.includes(label)
      ? chosen.filter((x) => x !== label)
      : [...chosen, label];
    const next: Partial<AskProgress> = {
      picked: withAt(picked, q.multiSelect ? mine : [label], []),
    };
    if (!q.multiSelect) {
      // A single choice is the option or the reader's own answer, not both.
      next.own = withAt(own, '', '');
      if (!quick && at < total - 1) next.index = at + 1;
    }
    save(next);
    if (quick) fill(label);
  };

  const write = (text: string) => {
    const next: Partial<AskProgress> = { own: withAt(own, text, '') };
    if (!q.multiSelect && text.trim()) next.picked = withAt(picked, [], []);
    save(next);
  };

  /** Enter: on to the next question, or fill the composer on the last. */
  const advance = () => {
    if (at < total - 1) setIndex(at + 1);
    else fill(reply);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    keepFocus.current = true;
    if (
      event.nativeEvent.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === 'Enter') {
      // A focused button takes Enter as its own click.
      if (!typing && event.target !== event.currentTarget) return;
      event.preventDefault();
      advance();
      return;
    }
    if (typing || !/^[1-9]$/.test(event.key)) return;
    const option = q.options[Number(event.key) - 1];
    if (option) {
      event.preventDefault();
      choose(option);
    }
  };

  return (
    <div
      role="group"
      aria-label={total > 1 ? `问题 ${at + 1}/${total}` : q.question}
      data-hc-ask-card=""
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mt-2 mb-2 rounded-lg outline-none bg-surface-raised p-3 font-sans ring-1 ring-surface-border"
    >
      {total > 1 && (
        <div className="mb-2 flex items-center gap-2 text-caption text-muted-foreground">
          <span className="tabular-nums" data-hc-ask-step="">
            问题 {at + 1}/{total}
          </span>
          <div className="flex flex-1 gap-1" aria-hidden>
            {questions.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  i === at
                    ? 'bg-foreground/60'
                    : (answers[i]?.length ?? 0) > 0
                      ? 'bg-foreground/25'
                      : 'bg-muted',
                )}
              />
            ))}
          </div>
        </div>
      )}
      <div
        key={at}
        className="animate-in duration-200 fade-in slide-in-from-right-1 motion-reduce:animate-none"
      >
        <div className="mb-2 text-body font-medium break-words text-foreground">
          {q.question}
          {q.multiSelect && (
            <span className="ml-1.5 text-caption font-normal text-muted-foreground">
              可多选
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((label, oi) => {
            const on = chosen.includes(label);
            const description = q.descriptions?.[oi];
            return (
              <button
                key={oi}
                type="button"
                aria-pressed={on}
                aria-keyshortcuts={oi < 9 ? String(oi + 1) : undefined}
                onClick={() => choose(label)}
                data-hc-question-option=""
                className={cn(
                  'inline-flex min-h-7 max-w-full cursor-pointer flex-col items-start justify-center rounded-md px-2.5 py-1 text-left text-caption font-medium break-words ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11 pointer-coarse:py-2',
                  on
                    ? 'bg-foreground text-background ring-foreground'
                    : 'bg-muted text-foreground ring-surface-border hover:bg-surface-hover',
                )}
              >
                <span>
                  {on && (
                    <Check
                      className="mr-1 inline size-3.5 align-[-0.15em]"
                      aria-hidden
                    />
                  )}
                  {label}
                </span>
                {description && (
                  <span
                    className={cn(
                      'mt-0.5 font-normal',
                      on ? 'text-background/75' : 'text-muted-foreground',
                    )}
                  >
                    {description}
                  </span>
                )}
              </button>
            );
          })}
          <input
            type="text"
            value={own[at] ?? ''}
            onChange={(event) => write(event.target.value)}
            placeholder="其他…"
            aria-label={`${q.question} 的其他答案`}
            enterKeyHint={at < total - 1 ? 'next' : 'done'}
            className={cn(
              'h-7 w-28 min-w-0 rounded-md bg-transparent px-2.5 text-caption text-foreground ring-1 ring-surface-border transition-[width,box-shadow] outline-none placeholder:text-muted-foreground focus:w-48 focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-11 pointer-coarse:text-base',
              (own[at] ?? '').trim() && 'w-48 ring-foreground/60',
            )}
          />
        </div>
      </div>
      {quick ? (
        <div className="mt-2 text-caption text-muted-foreground">
          {filled
            ? '已填入输入框，可修改后发送'
            : '点选项填入输入框，或写下其他答案后按回车'}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1.5">
          {total > 1 && (
            <>
              <NavButton
                label="上一题"
                disabled={at === 0}
                onClick={() => setIndex(at - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </NavButton>
              <NavButton
                label="下一题"
                disabled={at === total - 1}
                onClick={() => setIndex(at + 1)}
              >
                <ChevronRight className="size-4" aria-hidden />
              </NavButton>
            </>
          )}
          <span className="flex-1 truncate text-caption text-muted-foreground">
            {isFilled
              ? '已填入输入框，可修改后发送'
              : total > 1
                ? `已答 ${answered}/${total}`
                : '选好后填入输入框，或直接输入回复'}
          </span>
          <button
            type="button"
            disabled={!reply || isFilled}
            onClick={() => fill(reply)}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-foreground px-3 text-caption font-medium text-background transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-40 pointer-coarse:h-11"
          >
            {isFilled ? '已填入' : '填入输入框'}
          </button>
        </div>
      )}
    </div>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground ring-1 ring-surface-border transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-40 pointer-coarse:size-11"
    >
      {children}
    </button>
  );
}

/** A question's answer: the options picked and the reader's own words. */
function mergeAnswer(
  picked: readonly string[],
  own: string,
  multiSelect: boolean | undefined,
): string[] {
  const text = own.trim();
  if (!text) return [...picked];
  return multiSelect ? [...picked, text] : [text];
}

/**
 * The reply text: one question gives its answers alone; several give each
 * answer under its question. No `1.` numbering: the composer would turn it
 * into a list and drop the numbers.
 */
export function composeReply(
  questions: readonly StepQuestion[],
  answers: readonly (readonly string[])[],
): string {
  if (questions.length === 1) return (answers[0] ?? []).join('、');
  return questions
    .map((q, i) =>
      (answers[i]?.length ?? 0) > 0
        ? `${q.question}\n答：${answers[i].join('、')}`
        : '',
    )
    .filter(Boolean)
    .join('\n');
}
