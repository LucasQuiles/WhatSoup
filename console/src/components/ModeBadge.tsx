/**
 * ModeBadge.tsx — thin wrapper over the ModeBadge primitive (DUP-07 migration, badge.md).
 *
 * Kept for backward compatibility with existing consumers (SoupKitchen, LinePicker, etc.).
 * Prop contract preserved: mode prop accepts Mode | string.
 */
import { type FC } from 'react';
import { ModeBadge as ModeBadgePrimitive } from './primitives/Badge';
import type { Mode } from '../lib/status-map';

interface ModeBadgeProps {
  mode: Mode | string;
}

const ModeBadge: FC<ModeBadgeProps> = ({ mode }) => (
  <ModeBadgePrimitive mode={mode} />
);

export default ModeBadge;
