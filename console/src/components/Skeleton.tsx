import { type FC } from 'react';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

const Skeleton: FC<SkeletonProps> = ({ className = '', style }) => (
  <div className={`animate-shimmer ${className}`} style={style} />
);

export function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-3 items-center">
          <Skeleton className="w-2 h-2 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: `${140 + i * 20}px` }} />
          <Skeleton className="w-15 h-4.5 rounded" />
          <div className="flex-1" />
          <Skeleton className="w-10 h-3.5" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
