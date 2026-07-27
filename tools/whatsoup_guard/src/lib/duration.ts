/**
 * Shared duration-string grammar for whatsoup_guard: a positive integer with
 * no leading zero followed by one of the four unit suffixes (s/m/h/d), e.g.
 * "30s", "5m", "8h", "72h". Single source for both policy-schema validation
 * (policy/schema.ts) and CLI duration parsing (cli/mute.ts) so the two
 * consumers cannot silently diverge on what counts as a valid duration.
 */
export const DURATION_PATTERN = /^([1-9]\d*)([smhd])$/;

const EXACT_UNITS = [
  ['d', 24 * 60 * 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['m', 60 * 1000],
  ['s', 1000],
] as const;

export function formatDurationMsExact(ms: number): string {
  if (ms <= 0) return '0s';
  for (const [suffix, unitMs] of EXACT_UNITS) {
    if (ms % unitMs === 0) return `${ms / unitMs}${suffix}`;
  }
  return `${ms}ms`;
}
