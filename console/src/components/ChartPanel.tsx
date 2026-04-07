import { type FC, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';

export type ChartKey = 'messages' | 'tokens' | 'sessions';

interface ChartPanelProps {
  title: string;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
  instancesFailed?: number;
  expanded?: boolean;
  onRetry?: () => void;
  children: ReactNode;
}

export const ChartPanel: FC<ChartPanelProps> = ({
  title,
  isLoading,
  isError,
  hasData,
  instancesFailed = 0,
  expanded = false,
  onRetry,
  children,
}) => {
  const height = expanded ? 240 : 140;

  return (
    <section
      className="font-mono flex-shrink-0 rounded-[var(--radius-md)] bg-d3 p-[var(--sp-3)] c-border"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--sp-2)]">
        <span className="c-section-label">{title}</span>
        {instancesFailed > 0 && (
          <span
            className="font-mono rounded-sm px-[var(--sp-1h)] py-[var(--sp-0h)] text-s-warn"
            style={{
              fontSize: 'var(--font-size-label)',
              backgroundColor: 'var(--s-warn-wash)',
              borderWidth: 'var(--bw)',
              borderStyle: 'solid',
              borderColor: 'var(--s-warn-border)',
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
          className="animate-shimmer rounded-sm bg-d4"
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
