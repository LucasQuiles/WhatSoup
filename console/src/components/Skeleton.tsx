import { type FC } from 'react';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

const TABLE_SKELETON_WIDTHS = [
  'var(--config-key-col)',
  'calc(var(--config-key-col) + var(--sp-5))',
  'calc(var(--config-key-col) + var(--sp-10))',
  'calc(var(--config-key-col) + var(--sp-10) + var(--sp-5))',
  'calc(var(--config-key-col) + var(--sp-10) + var(--sp-10))',
] as const;

const Skeleton: FC<SkeletonProps> = ({ className = '', style }) => (
  <div className={`skeleton-bar ${className}`} style={style} />
);

export function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-3 items-center">
          <Skeleton className="w-2 h-2 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: TABLE_SKELETON_WIDTHS[i] ?? TABLE_SKELETON_WIDTHS[0] }} />
          <Skeleton className="w-15 h-4.5 rounded" />
          <div className="flex-1" />
          <Skeleton className="w-10 h-3.5" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
