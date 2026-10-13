import { Activity, CircleCheck, EyeOff, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProcessVisibility } from '../../types';
import { PROCESS_VISIBILITY_OPTIONS } from '../../lib/process-visibility';

const ICONS: Record<ProcessVisibility, typeof Activity> = {
  hidden: EyeOff,
  activity: Activity,
  full: Sparkles,
};

interface ProcessVisibilitySelectorProps {
  value: ProcessVisibility;
  onChange: (value: ProcessVisibility) => void;
  disabled?: boolean;
  name: string;
}

/**
 * How much of a proactive turn the Web shows beside the spinner. It only
 * decides what this workspace's Web conversation displays: nothing is
 * restarted and no other channel changes.
 */
export function ProcessVisibilitySelector({
  value,
  onChange,
  disabled = false,
  name,
}: ProcessVisibilitySelectorProps) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-body font-medium text-foreground">
        过程可见性
      </legend>
      <p className="mt-1 text-caption leading-5 text-muted-foreground">
        主动模式下，Web 在“正在处理…”旁显示多少处理过程。只影响 Web
        展示，不重启运行时，也不影响飞书等渠道。
      </p>
      <div className="mt-2 grid gap-2">
        {PROCESS_VISIBILITY_OPTIONS.map((option) => {
          const Icon = ICONS[option.value];
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1 transition-colors duration-100',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                selected
                  ? 'bg-surface-selected ring-foreground/25'
                  : 'bg-transparent ring-surface-border hover:bg-surface-hover',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <Icon
                aria-hidden="true"
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  selected ? 'text-foreground' : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0">
                <span className="block pr-5 text-label text-foreground">
                  {option.label}
                </span>
                <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </span>
              {selected && (
                <CircleCheck
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-primary-text"
                />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
