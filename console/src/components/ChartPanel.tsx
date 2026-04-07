import { type FC, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, BarChart3 } from 'lucide-react';

export type ChartKey = 'messages' | 'tokens' | 'sessions';

interface ChartPanelProps {
  title: string;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
  instancesFailed: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
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
  onToggleExpand,
  onRetry,
  children,
}) => {
  // height is dynamic (depends on expanded prop) — 120px collapsed / 200px expanded; no fixed token covers these values
  const height = expanded ? 200 : 120;

  return (
    <section className="c-card font-mono flex-shrink-0 p-[var(--sp-4)] bg-d2">
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--sp-3)]">
        <button
          type="button"
          className="font-mono text-t4 uppercase tracking-[var(--tracking-label)] cursor-pointer hover:text-t2 flex items-center gap-[var(--sp-1)]"
          style={{ fontSize: 'var(--font-size-xs)' }}
          onClick={onToggleExpand}
        >
          {title}
          {onToggleExpand && (expanded
            ? <ChevronUp size={12} strokeWidth={1.75} />
            : <ChevronDown size={12} strokeWidth={1.75} />
          )}
        </button>
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
