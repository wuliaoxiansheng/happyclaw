import { useShellStore } from '../../stores/shell';

/**
 * AskUserQuestion options. The runner has no interactive answer channel, so
 * the reply is the user's next message: an option click fills the composer.
 */
export function AskUserQuestionCard({
  toolInput,
}: {
  toolInput: Record<string, unknown>;
}) {
  // Support both "question" (string) and "questions" (array) formats
  const questions: Array<{
    question: string;
    options?: Array<{ value: string; label?: string }>;
  }> = [];
  if (Array.isArray(toolInput.questions)) {
    for (const q of toolInput.questions) {
      if (q && typeof q === 'object' && 'question' in q) {
        questions.push(
          q as {
            question: string;
            options?: Array<{ value: string; label?: string }>;
          },
        );
      }
    }
  } else if (typeof toolInput.question === 'string') {
    questions.push({
      question: toolInput.question,
      options: Array.isArray(toolInput.options) ? toolInput.options : undefined,
    });
  }

  if (questions.length === 0) return null;

  return (
    <div className="mt-2 mb-2 space-y-2">
      {questions.map((q, qi) => (
        <div
          key={qi}
          className="rounded-lg bg-surface-raised p-3 font-sans ring-1 ring-surface-border"
        >
          <div className="mb-2 text-body font-medium text-foreground">
            {q.question}
          </div>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => {
                const label = opt.label || opt.value || '';
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={!label}
                    onClick={() =>
                      useShellStore.getState().requestComposerDraft(label)
                    }
                    className="inline-flex h-7 cursor-pointer items-center rounded-md bg-muted px-2.5 text-caption font-medium text-foreground ring-1 ring-surface-border transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default pointer-coarse:h-10"
                  >
                    {label || '—'}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-2 text-caption text-muted-foreground">
            点选项填入输入框，或直接输入回复后发送
          </div>
        </div>
      ))}
    </div>
  );
}
