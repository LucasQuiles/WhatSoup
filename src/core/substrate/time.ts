// src/core/substrate/time.ts
import { nowUnixSec } from '../../fleet/time-utils.ts';
export { nowUnixSec };

/** Clamp requestedTerminalAt to now + maxHours*3600. */
export function clampTtl(now: number, requested: number | null | undefined, maxHours: number): number {
  const hardMax = now + maxHours * 3600;
  if (requested == null) return hardMax;
  return Math.min(requested, hardMax);
}
