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
 * Lives here, in the policy module every side already imports, because EVERY
 * place that draws a DESTRUCTIVE or PAGING conclusion from a non-'present'
 * bond must not draw it from an indefinite read. There are five, and four of
 * them consult this predicate:
 *
 * - AuthBondGuard's restore path, which renames the live auth root away;
 * - AuthBondGuard's capture path, whose failure result is paged as a confirmed
 *   repair;
 * - ConnectionManager's connect preflight, which pages the same alert and then
 *   loads an auth state reader that initialises fresh credentials;
 * - classifyAuthFailure, which pages on local corruption;
 * - ConnectionManager's QR handler, `handleConnectionUpdate` in
 *   src/transport/connection.ts, which takes a live inspect() and pages
 *   'qr-required' from it. THIS ONE IS NOT GATED, deliberately and only so far
 *   as the page itself goes: a QR event is independent evidence that the
 *   credential did not authenticate, so the alert is earned no matter how the
 *   read went. What is NOT earned is the integrity verdict attached to it.
 *   `localAuthBondFailureCriticalAsset` derives confidence 'confirmed' for any
 *   snapshot that is not clean-and-present, so a transient read produces a
 *   confirmed credential_integrity claim from an observation that established
 *   nothing. It compounds: `localAuthAlertEmitted` allows one such page per
 *   process and clears only on a verified send, so a transient-classified page
 *   can hold the slot ahead of the accurate one. KNOWN RESIDUAL with a
 *   follow-up; not addressed here.
 *
 * Sharing one predicate is what stops a new transient reason being added to one
 * and forgotten in the others. This list named only the first and fourth of the
 * five for a release, and two of the three it left out drew exactly the
 * conclusions it exists to prevent — so keep it complete, and treat a new
 * consumer of a non-'present' status as needing an entry here rather than a
 * local test.
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
