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
import { resolveStatus, resolveMode, STATUS_MAP } from '../../lib/status-map';
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
  /**
   * True when the shown status is CARRIED FORWARD from an older live
   * observation (LineInstance.stale, #1762 seam) rather than freshly
   * proven. A green/ok shape is demoted to the warn diamond (never green
   * without a fresh observation — D-3/F-UX-4) and the shape's aria-label
   * is qualified; the carried status label text stays visible (#1762
   * rem-1: degrade confidence, never hide). Non-ok shapes are unchanged —
   * a carried alarm stays an alarm (demoting crit would hide severity).
   */
  carried?: boolean;
}

export const StatusCell: FC<StatusCellProps> = ({
  status,
  name,
  live = false,
  labelStyle,
  carried = false,
}) => {
  const entry = resolveStatus(status);

  // The map is the single rendering driver (badge.md "one canonical map"):
  // classes and tokens are defined together in STATUS_MAP, not re-derived here.
  // Carried demotion: only the ok/green entry demotes (to the map's own
  // warn-diamond pairing, ink included) — every other shape renders as mapped.
  const demoteOk = carried && entry === STATUS_MAP.online;
  const shapeClass = demoteOk ? STATUS_MAP.unknown.shapeClass : entry.shapeClass;
  const liveClass = (entry.shape === 'disc' && live && !carried) ? ' soup-shape--live' : '';
  const labelInkClass = demoteOk ? STATUS_MAP.unknown.labelClass : entry.labelClass;
  const shapeAriaLabel = demoteOk ? `${entry.label}, carried forward` : entry.label;

  // When a name is provided and labelStyle is not forced to 'status',
  // render the name as the prominent label and put the status label on the shape.
  const showName = name !== undefined && labelStyle !== 'status';

  return (
    <span className="soup-status-cell">
      <span
        className={shapeClass + liveClass}
        aria-label={shapeAriaLabel}
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
