import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MessageAutomationOrigin } from '../../stores/chat';
import { automationHref } from './automation-actions';

/** Prompts longer than this start folded in the bubble. */
const FOLD_LINES = 6;
const FOLD_CHARS = 400;

/** 「由自动化「X」发送」 above an automation's input; opens the automation. */
export function AutomationOriginLink({
  automation,
  className,
}: {
  automation: MessageAutomationOrigin;
  className?: string;
}) {
  return (
    <Link
      to={automationHref(automation.id)}
      // Not part of the message: copying or selecting the bubble skips it.
      className={cn(
        'mb-1 inline-flex max-w-full items-center gap-1 rounded-sm text-caption text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      <Timer className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">由自动化「{automation.name}」发送</span>
    </Link>
  );
}

function isLongAutomationPrompt(content: string): boolean {
  return content.length > FOLD_CHARS || content.split('\n').length > FOLD_LINES;
}

/** An automation's prompt in its bubble, folded when long. */
export function AutomationPromptText({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const long = isLongAutomationPrompt(content);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <p
        className={cn(
          'text-body-lg break-words whitespace-pre-wrap',
          long && !expanded && 'line-clamp-6',
          className,
        )}
      >
        {content}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 cursor-pointer rounded-sm text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </>
  );
}
