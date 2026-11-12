import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  debounce?: number;
  className?: string;
  autoFocus?: boolean;
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索...',
  ariaLabel,
  debounce = 300,
  className,
  autoFocus,
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (v: string) => {
    setLocalValue(v);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(v), debounce);
  };

  const handleClear = () => {
    setLocalValue('');
    clearTimeout(timerRef.current);
    onChange('');
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        variant="code"
        enterKeyHint="search"
        className="pr-8 pl-8 phone:pr-11"
        autoFocus={autoFocus}
      />
      {localValue && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="清空搜索"
          className="absolute top-1/2 right-0 grid size-8 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground phone:size-11"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
