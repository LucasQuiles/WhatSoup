/**
 * LogStream.tsx — the first-class log surface primitive (log-stream.md).
 *
 * Four-lane grid: time 72px · level 24px · source 96px · message 1fr.
 * Lane widths are LogStream component tokens defined in tokens.component.css:
 *   --log-time-w, --log-level-w, --log-source-w.
 *
 * No virtualization — LogStream renders bounded poll snapshots today (DD-22).
 * Virtualization is required by spec for unbounded live-tail streams and will
 * be built when a streaming log source exists (blocks: before any live-tail
 * feature ships; owner: LogStream maturity slice).
 *
 * Not a live region (no aria-live) — log spam would drown screen readers.
 * Escalation is carried by the attention metric and feed (log-stream.md §Accessibility).
 *
 * Row keys are stable across poll refreshes (timestamp + position index as
 * fallback) so keyboard focus survives React reconciliation when new entries
 * arrive (investigation §6.5).
 *
 * C-3 constraint: live-tail = poll-refresh append semantics only; streaming
 * is out of scope (investigation §13).
 */
import {
  type FC,
  type KeyboardEvent,
  useState,
} from 'react';
import type { LogEntry } from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogDensity = 'default' | 'compressed';

export interface LogStreamProps {
  /** Log entries to render. */
  entries: LogEntry[];
  /**
   * Row height density.
   * 'default' = 36px; 'compressed' = 28px (spec-normative for drawer use).
   */
  density?: LogDensity;
  /**
   * Scoped last-N for drawer usage — slices the tail.
   * When provided, only the last N entries are rendered.
   */
  maxEntries?: number;
  /**
   * Message shown when entries is empty.
   * Default: "No log entries in this range."
   */
  emptyMessage?: string;
  /**
   * Message shown when entries exist but all are filtered away by the caller.
   * Caller is responsible for passing the correct (filtered) array;
   * LogStream does not filter internally.
   */
  filteredEmptyMessage?: string;
  /**
   * When true, LogStream was rendered after filtering (caller signal).
   * If entries.length === 0 and isFiltered=true, filteredEmptyMessage is used.
   */
  isFiltered?: boolean;
  /** When provided, renders the error state with an optional Retry button. */
  error?: string;
  /** Called when the Retry button is clicked in the error state. */
  onRetry?: () => void;
  /** Optional CSS class added to the log container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Level tag helpers
// ---------------------------------------------------------------------------

/** Single letter and CSS modifier class per log level. */
function levelConfig(level: LogEntry['level']): { letter: string; cls: string } {
  switch (level) {
    case 'error':
      return { letter: 'E', cls: 'soup-log__lvl--error' };
    case 'warn':
      return { letter: 'W', cls: 'soup-log__lvl--warn' };
    case 'info':
      return { letter: 'I', cls: 'soup-log__lvl--info' };
    case 'debug':
      return { letter: 'D', cls: 'soup-log__lvl--debug' };
  }
}

// ---------------------------------------------------------------------------
// LogRow — individual log entry row
// ---------------------------------------------------------------------------

interface LogRowProps {
  entry: LogEntry;
}

const LogRow: FC<LogRowProps> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);

  const { letter, cls } = levelConfig(entry.level);

  const toggle = () => setExpanded((v) => !v);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  const rowSeverityCls =
    entry.level === 'error'
      ? 'soup-log__row--error'
      : entry.level === 'warn'
        ? 'soup-log__row--warn'
        : '';

  return (
    <div
      role="listitem"
      tabIndex={0}
      className={['soup-log__row', rowSeverityCls, expanded ? 'is-open' : '']
        .filter(Boolean)
        .join(' ')}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <div className="soup-log__grid">
        {/* Time lane — --type-data-sm, --text-3, monospaced */}
        <span className="soup-log__time">{entry.timestamp}</span>

        {/* Level lane — bordered letter chip: color + border + letter (triple channel) */}
        <span className={`soup-log__lvl ${cls}`} aria-label={`level ${entry.level}`}>
          {letter}
        </span>

        {/* Source lane — ellipsis truncation; full value in title attr */}
        <span className="soup-log__source" title={entry.source}>
          {entry.source}
        </span>

        {/* Message lane — wraps multi-word (overflow-wrap), breaks long tokens */}
        <span className="soup-log__msg">{entry.msg}</span>
      </div>

      {/* Detail bed — visible when expanded; snaps (no slide per motion.md §5) */}
      {expanded && (
        <div className="soup-log__detail">
          {entry.component && (
            <span className="soup-log__detail-component">
              component: {entry.component}
            </span>
          )}
          <pre className="soup-log__detail-pre">{entry.msg}</pre>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// LogStream (container)
// ---------------------------------------------------------------------------

export const LogStream: FC<LogStreamProps> = ({
  entries,
  density = 'default',
  maxEntries,
  emptyMessage = 'No log entries in this range.',
  filteredEmptyMessage = 'No entries match the current filter.',
  isFiltered = false,
  error,
  onRetry,
  className,
}) => {
  // Slice the tail when maxEntries is set (scoped last-N for drawer usage).
  const visible =
    maxEntries !== undefined && maxEntries > 0
      ? entries.slice(-maxEntries)
      : entries;

  const containerClass = [
    'soup-log',
    density === 'compressed' ? 'soup-log--compressed' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Error state — distinct from rendered error-level rows (log-stream.md §States).
  if (error) {
    return (
      <div className={containerClass} role="list">
        <div className="soup-log__state soup-log__state--error" role="listitem">
          <span className="soup-log__state-msg">{error}</span>
          {onRetry && (
            <button
              type="button"
              className="soup-log__state-retry soup-btn soup-btn--neutral soup-btn--sm"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // Empty state (default empty or filtered-empty)
  if (visible.length === 0) {
    const msg = isFiltered ? filteredEmptyMessage : emptyMessage;
    return (
      <div className={containerClass} role="list">
        <div className="soup-log__state" role="listitem">
          <span className="soup-log__state-msg">{msg}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass} role="list">
      {visible.map((entry, idx) => {
        // Stable key: timestamp is primary; index guards duplicate timestamps
        // in the same poll snapshot. Focus survives poll-refresh rerenders
        // because the key is stable for the same entry (investigation §6.5).
        const stableKey = `${entry.timestamp}-${idx}`;
        return <LogRow key={stableKey} entry={entry} />;
      })}
    </div>
  );
};
