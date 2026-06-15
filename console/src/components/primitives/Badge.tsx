/**
 * Badge.tsx — StatusCell and ModeBadge primitives (badge.md).
 *
 * StatusCell: [shape] [label] — shape law renders disc/diamond/square/outline + label.
 * ModeBadge:  6px square dot + word — passive/chat/agent identity.
 *
 * These are the ONLY two renderers for status/mode state in the product.
 * Import status/mode data from status-map.ts; never pass raw hex or class
 * names from outside this module.
 */
import { type FC } from 'react';
import { resolveStatus, resolveMode } from '../../lib/status-map';
import type { Status, Mode } from '../../lib/status-map';

// ---------------------------------------------------------------------------
// StatusCell
// ---------------------------------------------------------------------------

export interface StatusCellProps {
  /** Connection status. Unknown strings render outline + raw value (fail-visible). */
  status: Status | string;
  /**
   * Optional line/instance name shown instead of the status label.
   * When provided, the status label is used for the shape's aria-label only.
   */
  name?: string;
  /** When true the ok-disc carries the breathing halo (reduced-motion safe). */
  live?: boolean;
  /**
   * 'name' — show the instance name as primary label (default when name is provided).
   * 'status' — always show the status label.
   */
  labelStyle?: 'name' | 'status';
}

export const StatusCell: FC<StatusCellProps> = ({
  status,
  name,
  live = false,
  labelStyle,
}) => {
  const entry = resolveStatus(status);

  // The map is the single rendering driver (badge.md "one canonical map"):
  // classes and tokens are defined together in STATUS_MAP, not re-derived here.
  const shapeClass = entry.shapeClass;
  const liveClass = (entry.shape === 'disc' && live) ? ' soup-shape--live' : '';
  const labelInkClass = entry.labelClass;

  // When a name is provided and labelStyle is not forced to 'status',
  // render the name as the prominent label and put the status label on the shape.
  const showName = name !== undefined && labelStyle !== 'status';

  return (
    <span className="soup-status-cell">
      <span
        className={shapeClass + liveClass}
        aria-label={entry.label}
        role="img"
      />
      {showName ? (
        <span className="soup-status-cell__name">{name}</span>
      ) : (
        <span className={labelInkClass}>{entry.label}</span>
      )}
    </span>
  );
};

// ---------------------------------------------------------------------------
// ModeBadge
// ---------------------------------------------------------------------------

export interface ModeBadgeProps {
  /** Operating mode. */
  mode: Mode | string;
}

export const ModeBadge: FC<ModeBadgeProps> = ({ mode }) => {
  const entry = resolveMode(mode);

  if (!entry) {
    // Unknown mode — render neutral with raw value (fail-visible)
    return (
      <span className="soup-mode soup-mode--unknown">
        <span className="soup-mode__dot soup-mode__dot--unknown" />
        {mode}
      </span>
    );
  }

  const modeClass = entry.modeClass;

  return (
    <span className={modeClass}>
      <span className="soup-mode__dot" />
      {entry.label}
    </span>
  );
};
