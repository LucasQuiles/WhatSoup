// src/lib/time-units.ts
// SSOT for time-unit constants (#2207). All values are MILLISECONDS —
// modules that work in unix seconds (e.g. media-retention DB cutoffs)
// must not substitute these for their seconds literals.

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;
