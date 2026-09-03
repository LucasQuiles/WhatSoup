export const DEFAULT_FRESH_INVALID_GRACE_MS = 10_000;

/**
 * Auth-bond issue prefixes that mean "could not establish this", never "this
 * is broken".
 *
 * A nonblocking open that returns EAGAIN/EWOULDBLOCK says "not now" and says
 * nothing about the credential behind the path. An incomplete bounded read
 * says the same thing about the read: the operation bound was reached before
 * end-of-file, so the descriptor was never read to a verdict.
 */
export const TRANSIENT_AUTH_READ_ISSUE_PREFIXES = [
  'creds_json_read_transient:',
  'auth_dir_read_transient:',
  'creds_json_read_incomplete:',
] as const;

/**
 * The auth-failure class for a transient read that has outlived its bound.
 *
 * Named here, in the module both the producer and the classifier import, so
 * the string cannot drift between them. NON-TERMINAL by construction: it says
 * the credential could not be READ, and says nothing about whether it is
 * intact, so it must not appear in any terminal set. The consumers that decide
 * that are `authFailureIsUnhealthy` in src/core/health.ts,
 * TERMINAL_AUTH_FAILURE_CLASSES in src/fleet/auth-loss-signals.ts and the
 * poller's copy, and TERMINAL_AUTH_FAILURES in
 * deploy/templates/watchdog-script.sh — a restart may clear a read fault, so
 * the watchdog must be allowed to try one.
 */
export const AUTH_BOND_READ_PERSISTENT_CLASS = 'auth_bond_read_persistent';

/**
 * Does this auth-bond snapshot carry a transient read?
 *
 * Lives here, in the policy module both sides already import, because the two
 * places that draw a DESTRUCTIVE or PAGING conclusion from a non-'present'
 * bond must not draw it from an indefinite read: AuthBondGuard's restore path,
 * which renames the live auth root away, and classifyAuthFailure, which pages
 * on local corruption. Sharing one predicate is what stops a new transient
 * reason being added to one and forgotten in the other.
 *
 * Implemented over `transientAuthReadIssue` rather than scanning the prefix
 * list a second time, so the question "is there one" and the question "which
 * one" cannot answer differently.
 */
export function hasTransientAuthReadIssue(issues: readonly string[]): boolean {
  return transientAuthReadIssue(issues) !== null;
}

/**
 * The transient issue that owns the current streak, or null when none does.
 *
 * The FIRST matching issue in list order, so one snapshot cannot start two
 * streaks and the choice is deterministic across reads. The streak is keyed by
 * this exact text: a change of reason ends one episode and starts another, so
 * the serialized reason and age on the health surface always describe the same
 * fault rather than an age accumulated across a sequence of different ones.
 */
export function transientAuthReadIssue(issues: readonly string[]): string | null {
  return issues.find(
    issue => TRANSIENT_AUTH_READ_ISSUE_PREFIXES.some(prefix => issue.startsWith(prefix)),
  ) ?? null;
}
