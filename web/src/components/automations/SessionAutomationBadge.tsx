import { useNavigate } from 'react-router-dom';
import { Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { automationSubtitle } from '../../lib/automation-presentation';
import { automationHref } from './automation-actions';
import { useSessionAutomations } from './AutomationSessionBits';

/**
 * 「自动化」 or 「自动化 · N」 in the chat header for the automations whose
 * runs come to this session. One opens its detail; several open a list.
 */
export function SessionAutomationBadge({
  sessionJid,
  generatedBy,
  className,
}: {
  sessionJid: string;
  /** The automation that opened this session, if one did. */
  generatedBy?: string | null;
  className?: string;
}) {
  const navigate = useNavigate();
  const automations = useSessionAutomations(sessionJid, generatedBy);
  if (automations.length === 0) return null;
  const allPaused = automations.every((item) => item.status !== 'active');
  const label =
    automations.length === 1 ? '自动化' : `自动化 · ${automations.length}`;
  const badge = (
    <Badge
      asChild
      variant="outline"
      className={cn(
        'cursor-pointer gap-1',
        allPaused && 'text-faint-foreground',
        className,
      )}
    >
      <button
        type="button"
        aria-label={
          allPaused
            ? `${label}（已全部暂停）`
            : `${label}：${automations.map((item) => item.name).join('、')}`
        }
        onClick={
          automations.length === 1
            ? () => navigate(automationHref(automations[0].id))
            : undefined
        }
      >
        <Timer />
        {label}
      </button>
    </Badge>
  );
  if (automations.length === 1) return badge;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{badge}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {automations.map((automation) => (
          <DropdownMenuItem
            key={automation.id}
            onClick={() => navigate(automationHref(automation.id))}
            className="flex-col items-start gap-0"
          >
            <span className="w-full truncate text-label">
              {automation.name}
            </span>
            <span className="w-full truncate text-caption text-muted-foreground">
              {automationSubtitle(automation)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
