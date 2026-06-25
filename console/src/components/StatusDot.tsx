/**
 * StatusDot.tsx — thin wrapper over StatusCell (DUP-06 migration, badge.md).
 *
 * Kept for backward compatibility with existing consumers (LinePicker, etc.).
 * Prop contract: status.
 *
 * MIGRATION NOTE: The previous implementation rendered color-only (no label).
 * This wrapper renders StatusCell which always shows shape + label per the
 * shape law (badge.md).  For contexts that need shape-only, use StatusCell
 * directly with labelStyle="status".
 *
 * All status shapes are 8px per the shape law (the legacy 6px "sm" size used
 * --dot-feed which is deprecated in tokens-v3 §6.12).
 */
import { type FC } from 'react';
import { StatusCell } from './primitives/Badge';
import type { Status } from '../lib/status-map';

interface StatusDotProps {
  status: Status | string;
}

const StatusDot: FC<StatusDotProps> = ({ status }) => (
  <StatusCell status={status} />
);

export default StatusDot;
