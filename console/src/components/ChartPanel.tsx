import { type FC, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';

export type ChartKey = 'messages' | 'tokens' | 'sessions';

interface ChartPanelProps {
  title: string;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
  instancesFailed: number;
  expanded?: boolean;
  onRetry?: () => void;
  children: ReactNode;
}

export const ChartPanel: FC<ChartPanelProps> = ({
  title,
  isLoading,
  isError,
  hasData,
  instancesFailed,
  expanded = false,
  onRetry,
  children,
}) => {
  const height = expanded ? 200 : 120;

  return (
    <section className="font-mono flex-shrink-0 p-[var(--sp-3)] bg-d3 rounded-[var(--radius-md)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--sp-2)]">
        <span
          className="font-mono text-t4 uppercase tracking-[var(--tracking-label)]"
          style={{ fontSize: 'var(--font-size-xs)' }}
        >
          {title}
        </span>
        {instancesFailed > 0 && (
          <span
            className="font-mono rounded-sm px-[var(--sp-1h)] py-[var(--sp-half)] text-s-warn bg-[var(--s-warn-wash)]"
            style={{
              fontSize: 'var(--font-size-label)',
              borderWidth: 'var(--bw)',
              borderStyle: 'solid',
              borderColor: 'var(--color-s-warn)',
            }}
          >
            {`${instancesFailed} instance(s) unavailable`}
          </span>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div
          data-testid="chart-shimmer"
          className="animate-shimmer rounded-md bg-d3"
          style={{ height }}
        />
      ) : isError ? (
        <div
          className="flex flex-col items-center justify-center text-center"
          style={{ height }}
        >
          <span className="text-s-crit font-sans" style={{ fontSize: 'var(--font-size-sm)' }}>
            Failed to load
          </span>
          {onRetry && (
            <button
              type="button"
              className="c-btn c-btn-sm c-btn-ghost mt-[var(--sp-2)]"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      ) : !hasData ? (
        <div
          className="flex flex-col items-center justify-center text-center text-t5"
          style={{ height }}
        >
          <BarChart3 size={24} strokeWidth={1.25} className="mb-[var(--sp-2)]" />
          <span className="font-sans" style={{ fontSize: 'var(--font-size-sm)' }}>
            No data yet
          </span>
        </div>
      ) : (
        <div style={{ height }}>
          {children}
        </div>
      )}
    </section>
  );
};
