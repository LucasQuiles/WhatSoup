/**
 * BulkActionBar.tsx — sticky multi-row action bar for the fleet table.
 *
 * Renders ONLY when `count > 0` (returns null otherwise, so the parent
 * doesn't need a render-gate). The bar exposes Restart / Stop / Delete
 * on the selected lines plus a Clear/deselect control; the parent
 * wires the action handlers (mirrors the FleetRowMenu per-row contract).
 *
 * Destructive routing: Delete uses `variant="danger"`. The parent is
 * responsible for showing a ConfirmDialog (one for the bulk operation,
 * not one per row) before invoking the destructive call. The bar does
 * NOT open its own confirm — the parent's handler chain owns the
 * confirmation policy.
 *
 * Styling: tokens only. --sp-* padding, --bw hairline border, --b1
 * color, --surface-raised background, --z-float when it floats.
 * role="region" + aria-label="Bulk actions" so screen readers announce
 * the bar when it appears; aria-live="polite" so the count update is
 * announced when rows are toggled.
 */
import { type FC } from 'react';
import { Button } from './primitives/Button';
import { X } from 'lucide-react';

export interface BulkActionBarProps {
  /** Number of rows currently selected. The bar renders only when > 0. */
  count: number;
  /** Restart the selected lines. */
  onRestart: () => void;
  /** Stop the selected lines. */
  onStop: () => void;
  /** Delete the selected lines (parent should confirm before firing). */
  onDelete: () => void;
  /** Deselect all rows. */
  onClear: () => void;
  /** Disables the bar (e.g. while a request is in flight). */
  disabled?: boolean;
  /** Optional class on the bar wrapper. */
  className?: string;
}

const ICON = 14;

export const BulkActionBar: FC<BulkActionBarProps> = ({
  count,
  onRestart,
  onStop,
  onDelete,
  onClear,
  disabled = false,
  className,
}) => {
  if (count === 0) return null;

  const wrapClass = ['soup-bulk-bar', className].filter(Boolean).join(' ');

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      aria-live="polite"
      className={wrapClass}
    >
      <span className="soup-bulk-bar__count" aria-label={`${count} selected`}>
        <span className="c-data">{count}</span>
        <span className="c-label">selected</span>
      </span>

      <span className="soup-bulk-bar__spring" />

      <Button
        variant="neutral"
        size="sm"
        onClick={onRestart}
        disabled={disabled}
      >
        Restart
      </Button>
      <Button
        variant="neutral"
        size="sm"
        onClick={onStop}
        disabled={disabled}
      >
        Stop
      </Button>
      <Button
        variant="danger"
        size="sm"
        onClick={onDelete}
        disabled={disabled}
      >
        Delete
      </Button>

      <span className="soup-bulk-bar__divider" aria-hidden="true" />

      <Button
        variant="ghost"
        size="sm"
        onClick={onClear}
        disabled={disabled}
        aria-label="Clear selection"
        icon={<X size={ICON} strokeWidth={1.75} aria-hidden="true" />}
      />
    </div>
  );
};

export default BulkActionBar;
