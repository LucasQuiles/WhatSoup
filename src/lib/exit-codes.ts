/**
 * Process exit-code classification (sysexits.h + systemd/launchd integration).
 *
 * When a fatal error occurs, the exit code tells the service manager
 * (systemd, launchd) whether to restart the process. Two categories:
 *
 * - **Transient** (`EX_TEMPFAIL`, `EX_UNAVAILABLE`, crash-style `EX_SOFTWARE`):
 *   the service manager should restart — the error may not recur.
 * - **Permanent** (`EX_USAGE`, `EX_CONFIG`, `EX_DATAERR`, `EX_NOINPUT`):
 *   restarting will hit the same error immediately, so the service manager
 *   should stop restart-flapping. systemd's `Restart=on-failure` will NOT
 *   restart when the exit code is in this set IF `RestartPreventExitStatus`
 *   lists them; launchd's `KeepAlive=false` honors any non-zero exit.
 *
 * The single most valuable constant here is `EX_CONFIG` (78): a fatal
 * configuration error (bad config.json, missing required env var, malformed
 * instance spec) should exit with 78 so systemd stops restarting into the
 * same broken state. This is the "stop restart-flapping" pattern from the
 * OpenClaw changelog.
 *
 * References:
 *  - sysexits.h (BSD): /usr/include/sysexits.h
 *  - systemd.unit(5): RestartPreventExitStatus
 */

/** sysexits.h constants (BSD). */
export const ExitCode = {
  /** Successful termination. */
  EX_OK: 0,
  /** Command line usage error. */
  EX_USAGE: 64,
  /** Data format error. */
  EX_DATAERR: 65,
  /** Cannot open input. */
  EX_NOINPUT: 66,
  /** Addressee unknown. */
  EX_NOUSER: 67,
  /** Host name unknown. */
  EX_NOHOST: 68,
  /** Service unavailable. */
  EX_UNAVAILABLE: 69,
  /** Internal software error. */
  EX_SOFTWARE: 70,
  /** System error (e.g., can't fork). */
  EX_OSERR: 71,
  /** Temporary failure; the service manager should retry. */
  EX_TEMPFAIL: 75,
  /** Configuration error — permanent; do NOT restart. */
  EX_CONFIG: 78,
  /** Permission denied. */
  EX_NOPERM: 77,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Exit codes that signal a PERMANENT error — restart will fail the same way. */
export const PERMANENT_EXIT_CODES: readonly number[] = [
  ExitCode.EX_USAGE,
  ExitCode.EX_DATAERR,
  ExitCode.EX_NOINPUT,
  ExitCode.EX_NOUSER,
  ExitCode.EX_NOHOST,
  ExitCode.EX_CONFIG,
  ExitCode.EX_NOPERM,
];

/** Exit codes that signal a TRANSIENT error — the service manager should retry. */
export const TRANSIENT_EXIT_CODES: readonly number[] = [
  ExitCode.EX_UNAVAILABLE,
  ExitCode.EX_TEMPFAIL,
  ExitCode.EX_OSERR,
];

/** True when the service manager should NOT restart after this exit code. */
export function isPermanentExitCode(code: number): boolean {
  return PERMANENT_EXIT_CODES.includes(code);
}

/** True when the exit code signals a transient/retryable failure. */
export function isTransientExitCode(code: number): boolean {
  return TRANSIENT_EXIT_CODES.includes(code);
}

/** Human-readable name for an exit code (e.g. 78 → "EX_CONFIG"). */
export function exitCodeName(code: number): string {
  for (const [name, value] of Object.entries(ExitCode)) {
    if (value === code) return name;
  }
  return `EX_UNKNOWN_${code}`;
}

/**
 * Error-shape tags used by {@link classifyErrorToExitCode}. The classifier
 * keys off these rather than off \`instanceof\` so it works across module
 * boundaries without import coupling.
 */
export type ErrorCategory =
  | 'config' // malformed config.json, missing required field
  | 'usage' // bad CLI flags
  | 'noinput' // required file/env missing
  | 'data' // data format / parse error
  | 'permission' // access denied
  | 'unavailable' // dependency down
  | 'tempfail' // rate limit, network blip
  | 'software' // internal bug
  | 'unknown';

/**
 * Classify an error category into the appropriate exit code.
 *
 * Config / usage / noinput / data / permission errors map to permanent codes
 * (do NOT restart). Unavailable / tempfail map to transient codes (retry).
 * Software / unknown default to EX_SOFTWARE (retry — the bug may not recur).
 */
export function classifyErrorToExitCode(category: ErrorCategory): number {
  switch (category) {
    case 'config':
      return ExitCode.EX_CONFIG;
    case 'usage':
      return ExitCode.EX_USAGE;
    case 'noinput':
      return ExitCode.EX_NOINPUT;
    case 'data':
      return ExitCode.EX_DATAERR;
    case 'permission':
      return ExitCode.EX_NOPERM;
    case 'unavailable':
      return ExitCode.EX_UNAVAILABLE;
    case 'tempfail':
      return ExitCode.EX_TEMPFAIL;
    case 'software':
      return ExitCode.EX_SOFTWARE;
    case 'unknown':
    default:
      return ExitCode.EX_SOFTWARE;
  }
}

/**
 * Heuristic: detect the error category from an Error's name/message.
 *
 * Matches on well-known substrings. Callers that know the exact category
 * should pass it directly to {@link classifyErrorToExitCode} instead of
 * relying on this heuristic.
 */
export function inferErrorCategory(error: Error): ErrorCategory {
  const name = error.name ?? '';
  const msg = (error.message ?? '').toLowerCase();
  if (name === 'SyntaxError' || /parse error|unexpected token|invalid json/i.test(msg)) {
    return 'data';
  }
  if (/config|configuration/i.test(msg) || /missing required/i.test(msg)) {
    return 'config';
  }
  if (/enoent|no such file|not found|missing/i.test(msg)) {
    return 'noinput';
  }
  if (/eacces|permission denied|eperm/i.test(msg)) {
    return 'permission';
  }
  if (/usage|invalid option|unknown flag|bad argument/i.test(msg)) {
    return 'usage';
  }
  if (/rate limit|too many requests|429|throttl/i.test(msg)) {
    return 'tempfail';
  }
  if (/econnrefused|econnreset|etimedout|unavailable|503|502/i.test(msg)) {
    return 'unavailable';
  }
  return 'unknown';
}
