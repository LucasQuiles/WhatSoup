import { type FC, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import { Button } from './primitives/Button';

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
  const panelHeight = expanded ? 'var(--chart-panel-h-expanded)' : 'var(--chart-panel-h)';

  return (
    <section
      className="font-mono flex-shrink-0 rounded-[var(--radius-md)] bg-surface-raised p-[var(--sp-3)] c-border"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--sp-2)]">
        <span className="c-section-label">{title}</span>
        {instancesFailed > 0 && (
          <span
            className="font-mono rounded-sm px-[var(--sp-1h)] py-[var(--sp-0h)] text-s-warn text-label"
            style={{
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
          className="skeleton-bar rounded-sm bg-btn-neutral-bg"
          style={{ height: panelHeight }}
        />
      ) : isError ? (
        <div
          className="flex flex-col items-center justify-center text-center"
          style={{ height: panelHeight }}
        >
          <span className="text-s-crit font-sans text-sm">
            Failed to load
          </span>
          {onRetry && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-[var(--sp-2)]"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      ) : !hasData ? (
        <div
          className="flex flex-col items-center justify-center text-center text-text-2"
          style={{ height: panelHeight }}
        >
          <BarChart3 size={24} strokeWidth={1.25} className="mb-[var(--sp-2)]" />
          <span className="font-sans text-sm">
            No data yet
          </span>
        </div>
      ) : (
        <div style={{ height: panelHeight }}>
          {children}
        </div>
      )}
    </section>
  );
};
