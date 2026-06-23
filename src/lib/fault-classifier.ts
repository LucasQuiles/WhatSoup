/** Named fault classes the fleet-health pipeline recognizes. Auth is the first. */
export type FaultClass = 'auth_terminal';

export interface FaultSignal {
  /** pino numeric level; 50 = error. */
  level: number;
  /** ops-alert source, e.g. 'provider_unknown_terminal'. */
  source?: string;
  /** structured log message signature. */
  message?: string;
}

/** ops-alert sources that denote a terminal auth failure. */
const AUTH_SOURCES = new Set(['provider_unknown_terminal']);

/** message prefixes that denote a terminal auth failure. Matched by prefix, never substring. */
const AUTH_MESSAGE_PREFIXES = ['suppressed unclassified terminal provider error from result'];

/**
 * Classify a structured log/alert signal into a fault class, or null.
 *
 * METRIC-INTEGRITY RULE: classification is driven ONLY by structured fields
 * (`level` + `source` + known message prefix). Bare status substrings such as
 * '401' are NEVER matched — that is the bug that produced the false multi-day
 * "storm" in the original post-mortem.
 */
export function classifyFault(signal: FaultSignal): FaultClass | null {
  if (signal.level < 50) return null;
  if (signal.source && AUTH_SOURCES.has(signal.source)) return 'auth_terminal';
  const message = signal.message ?? '';
  if (AUTH_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) return 'auth_terminal';
  return null;
}
