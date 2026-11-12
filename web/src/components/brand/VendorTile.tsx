import { cn } from '@/lib/utils';
import { VENDOR_MARKS, type VendorKind } from './vendorMarks';

interface VendorTileProps {
  /** Null shows the monogram of `name`. */
  vendor: VendorKind | null;
  /** The connection or model the tile stands for; its first letter is the fallback. */
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A vendor's mark in a small rounded tile, or the first letter of the name
 * when no mark is known. Decorative: the name is always written next to it.
 */
export function VendorTile({
  vendor,
  name,
  size = 'md',
  className,
}: VendorTileProps) {
  const mark = vendor ? VENDOR_MARKS[vendor] : null;
  return (
    <span
      aria-hidden="true"
      data-vendor={vendor ?? undefined}
      className={cn(
        'flex shrink-0 items-center justify-center bg-surface-selected text-foreground',
        size === 'sm' ? 'size-5 rounded-md' : 'size-7 rounded-lg',
        className,
      )}
    >
      {mark ? (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          fillRule={'evenOdd' in mark ? 'evenodd' : undefined}
          className={size === 'sm' ? 'size-3' : 'size-4'}
        >
          {mark.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : (
        <span
          className={cn(
            'font-semibold text-muted-foreground',
            size === 'sm' ? 'text-micro' : 'text-caption',
          )}
        >
          {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
        </span>
      )}
    </span>
  );
}
