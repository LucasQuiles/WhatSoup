// src/runtimes/agent/providers/claude-account-identity.ts
//
// Ratified-row account-identity verification for claude-cli (task-21).
//
// The owner ratifies ONE opaque digest per instance
// (`service.expectedAccountDigest`, captured at a known-good login with
// `npm run claude-account-digest`). On startup and on every primary-usability
// probe the runtime asks the claude CLI which account it is serving with —
// `claude auth status --json` in the bot's own scrubbed spawn env, the same
// read-only surface the diagnostic bundle's account-auth-status probe uses —
// digests the answer and compares digests.
//
// Contract:
//   - VERIFY ONLY. This module has no write seam: it never touches the file
//     store, the keychain, or the CLI's login state. A mismatch or an
//     unverifiable identity is reported (alert + health cause); nothing heals,
//     mirrors, or seeds a credential.
//   - Fail closed. Anything that is not a clean, parseable, logged-in status
//     whose digest equals the ratified digest is NOT a match: mismatch is its
//     own class, every other failure is `unverifiable` with a bounded reason.
//   - Content-free. The raw identity fields live only inside
//     parseClaudeAuthStatusIdentity; what leaves it is a digest, and what the
//     runtime publishes (logs, alerts, health) is a 12-hex digest prefix and a
//     status class. Never the raw CLI output.
//   - Never rejects. Probe failures are contained into the result.

import { safeStringEqual } from '../../../lib/safe-compare.ts';
import {
  accountIdentityDigestPrefix,
  computeAccountIdentityDigest,
  hasAccountIdentityControlCharacters,
  isAccountIdentityDigest,
} from '../../../lib/account-identity-digest.ts';
import { systemClock } from '../../../lib/clock.ts';
import { isNonEmptyString, isRecord } from '../../../lib/type-guards.ts';
import { getProviderBinary } from '../session.ts';
import { CLAUDE_AUTH_STATUS_ARGS, scrubbedAuthStatusEnv } from './account-auth-status.ts';
import {
  probeBinaryCommand,
  type BinaryAuthStatusResult,
  type BinaryCommandProbeOptions,
} from './binary-preflight.ts';

/** Same bound as the CLI model probe: `auth status` is local, but the CLI's
 *  own startup on a loaded host can exceed the 5 s preflight default. Exported
 *  because the operator capture script (scripts/claude-account-digest.ts) runs
 *  the same probe and must bound it identically — it used to carry its own
 *  unlinked copy of this number. */
export const ACCOUNT_IDENTITY_PROBE_TIMEOUT_MS = 15_000;

export type ObservedAccountIdentity =
  | { kind: 'identity'; digest: string }
  | { kind: 'absent'; reason: 'not-logged-in' | 'identity-fields-missing' }
  | { kind: 'unparseable' };

export type AccountIdentityVerificationStatus = 'disabled' | 'match' | 'mismatch' | 'unverifiable';

/** Bounded failure classes of the observation itself — everything that can go
 *  wrong between "resolve the binary" and "we hold a digest". Deliberately
 *  free of any notion of an EXPECTATION: comparing against a ratified digest is
 *  the verifier's job, and `expectation-malformed` is the verifier's own class. */
export type ObservedAccountIdentityFailureReason =
  | 'binary-missing'
  | 'probe-failed'
  | 'probe-threw'
  | 'not-logged-in'
  | 'identity-fields-missing'
  | 'unparseable';

export type AccountIdentityUnverifiableReason =
  | ObservedAccountIdentityFailureReason
  | 'expectation-malformed';

export interface AccountIdentityVerification {
  status: AccountIdentityVerificationStatus;
  reason: AccountIdentityUnverifiableReason | null;
  /** 12-hex correlation prefixes — never a full digest, never a raw identity. */
  expectedDigestPrefix: string | null;
  observedDigestPrefix: string | null;
  checkedAt: number;
}

export interface ClaudeAccountIdentityDeps {
  getProviderBinary?: (provider: string) => string | null;
  probeBinaryCommand?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: BinaryCommandProbeOptions,
  ) => Promise<BinaryAuthStatusResult>;
  /** Explicit env the spawn allow-list is scrubbed FROM (never forwarded whole). */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reduce raw `claude auth status --json` output to an observed identity. The
 * raw fields never leave this function: the only identity-bearing output is
 * the digest. A whole-output parse is tried first, then the outermost
 * `{...}` span (the CLI can print a warning line around the JSON).
 */
export function parseClaudeAuthStatusIdentity(output: string): ObservedAccountIdentity {
  const trimmed = output.trim();
  let status = trimmed === '' ? null : parseJsonObject(trimmed);
  if (status === null) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return { kind: 'unparseable' };
    status = parseJsonObject(trimmed.slice(start, end + 1));
    if (status === null) return { kind: 'unparseable' };
  }
  if (status['loggedIn'] === false) return { kind: 'absent', reason: 'not-logged-in' };
  if (status['loggedIn'] !== true) return { kind: 'absent', reason: 'identity-fields-missing' };
  const email = status['email'];
  const orgId = status['orgId'];
  if (!isNonEmptyString(email) || !isNonEmptyString(orgId)) {
    return { kind: 'absent', reason: 'identity-fields-missing' };
  }
  // A control character in either field would reach the `\n`-joined canonical
  // digest input (where it is ambiguous) and make computeAccountIdentityDigest
  // throw; classify it as an absent identity so verify stays never-rejecting.
  if (hasAccountIdentityControlCharacters(email) || hasAccountIdentityControlCharacters(orgId)) {
    return { kind: 'absent', reason: 'identity-fields-missing' };
  }
  return { kind: 'identity', digest: computeAccountIdentityDigest({ email, orgId }) };
}

/** Outcome of one observation: a digest, or a bounded failure reason. */
export type ObservedAccountIdentityOutcome =
  | { kind: 'identity'; digest: string }
  | { kind: 'failed'; reason: ObservedAccountIdentityFailureReason };

export interface ObserveClaudeAccountIdentityDeps extends ClaudeAccountIdentityDeps {
  /** Caller-supplied binary path. When set, provider resolution is skipped
   *  entirely (the capture script's `--binary` override). */
  binary?: string | null;
  signal?: AbortSignal;
}

/**
 * Resolve the binary, run the read-only auth-status probe, parse it, and
 * classify the result. THE one ladder — the runtime verifier below maps this
 * outcome to a verification status, and the operator capture script
 * (scripts/claude-account-digest.ts) maps it to exit codes and digest output.
 * Both used to implement this ladder separately.
 *
 * Order is load-bearing and must not be rearranged:
 *   - the binary is resolved before anything is spawned, so a missing binary
 *     never probes;
 *   - the output is parsed BEFORE the exit status is judged, because the CLI
 *     reports a logged-out state structurally on either exit path;
 *   - but a non-zero exit that is NOT that structured logged-out state is a
 *     probe failure even when the output looks like a valid identity — output
 *     that was never cleanly produced is not trusted.
 *
 * Never rejects: every failure, including a throwing resolver or spawn, is
 * contained into a returned reason. Content-free: raw identity fields stay
 * inside parseClaudeAuthStatusIdentity; what leaves here is a digest or a class.
 */
export async function observeClaudeAccountIdentity(
  deps: ObserveClaudeAccountIdentityDeps = {},
): Promise<ObservedAccountIdentityOutcome> {
  let binary: string | null = deps.binary ?? null;
  if (binary === null) {
    try {
      binary = (deps.getProviderBinary ?? getProviderBinary)('claude-cli');
    } catch {
      binary = null;
    }
  }
  if (!binary) return { kind: 'failed', reason: 'binary-missing' };

  let probe: BinaryAuthStatusResult;
  try {
    probe = await (deps.probeBinaryCommand ?? probeBinaryCommand)(
      binary,
      [...CLAUDE_AUTH_STATUS_ARGS],
      // env-allowed: explicit per-var allow-list scrubbed from the caller-supplied env, not passthrough
      scrubbedAuthStatusEnv(deps.env ?? process.env),
      {
        timeoutMs: deps.timeoutMs ?? ACCOUNT_IDENTITY_PROBE_TIMEOUT_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
  } catch {
    return { kind: 'failed', reason: 'probe-threw' };
  }

  const observed = parseClaudeAuthStatusIdentity(probe.output);
  if (probe.status !== 'ok') {
    return {
      kind: 'failed',
      reason: observed.kind === 'absent' && observed.reason === 'not-logged-in' ? 'not-logged-in' : 'probe-failed',
    };
  }
  if (observed.kind === 'unparseable') return { kind: 'failed', reason: 'unparseable' };
  if (observed.kind === 'absent') return { kind: 'failed', reason: observed.reason };
  return { kind: 'identity', digest: observed.digest };
}

/**
 * Verify the CLI's serving identity against the ratified digest. `null`
 * expectation = verification disabled (no spawn). Never rejects.
 */
export async function verifyClaudeAccountIdentity(
  expectedDigest: string | null,
  deps: ClaudeAccountIdentityDeps = {},
  signal?: AbortSignal,
): Promise<AccountIdentityVerification> {
  const now = deps.now ?? (() => systemClock.now());
  const expectedDigestPrefix = accountIdentityDigestPrefix(expectedDigest);
  const outcome = (
    status: AccountIdentityVerificationStatus,
    reason: AccountIdentityUnverifiableReason | null,
    observedDigest: string | null,
  ): AccountIdentityVerification => ({
    status,
    reason,
    expectedDigestPrefix,
    observedDigestPrefix: accountIdentityDigestPrefix(observedDigest),
    checkedAt: now(),
  });

  if (expectedDigest === null) {
    return { status: 'disabled', reason: null, expectedDigestPrefix: null, observedDigestPrefix: null, checkedAt: now() };
  }
  if (!isAccountIdentityDigest(expectedDigest)) return outcome('unverifiable', 'expectation-malformed', null);

  // Every observation failure is already a bounded reason, and this function's
  // whole remaining job is the digest comparison.
  const observed = await observeClaudeAccountIdentity({ ...deps, ...(signal ? { signal } : {}) });
  if (observed.kind === 'failed') return outcome('unverifiable', observed.reason, null);
  return safeStringEqual(observed.digest, expectedDigest)
    ? outcome('match', null, observed.digest)
    : outcome('mismatch', null, observed.digest);
}

export type AccountIdentityHealthStatus = 'disabled' | 'pending' | 'match' | 'mismatch' | 'unverifiable';

/** What /health publishes under `runtime.agent.accountIdentity`: status classes,
 *  a bounded reason, freshness, and digest prefixes. Nothing else. */
export interface AccountIdentityHealth {
  status: AccountIdentityHealthStatus;
  reason: AccountIdentityUnverifiableReason | 'stale-receipt' | 'never-verified' | null;
  stale: boolean;
  checkedAt: number | null;
  expectedDigestPrefix: string | null;
  observedDigestPrefix: string | null;
}

/**
 * Freshness-honest projection of the last verification. Fail-closed rules:
 *   - a match older than `freshnessMs` is NOT a match (`stale-receipt`);
 *   - a mismatch stays a mismatch however old it is (never downgraded);
 *   - with an expectation configured and no verification yet, the state is
 *     `pending` (no degradation reason — a boot-time transient must not arm
 *     the #2280 silence latch on a non-turn-provable reason) until the
 *     freshness window has elapsed since arming, then `never-verified`.
 */
export function deriveAccountIdentityHealth(input: {
  expectedConfigured: boolean;
  verification: AccountIdentityVerification | null;
  armedAtMs: number | null;
  nowMs: number;
  freshnessMs: number;
}): AccountIdentityHealth {
  const empty = { checkedAt: null, expectedDigestPrefix: null, observedDigestPrefix: null };
  if (!input.expectedConfigured) return { status: 'disabled', reason: null, stale: false, ...empty };
  const v = input.verification;
  if (v === null || v.status === 'disabled') {
    const overdue = input.armedAtMs !== null && input.nowMs - input.armedAtMs > input.freshnessMs;
    return overdue
      ? { status: 'unverifiable', reason: 'never-verified', stale: true, ...empty }
      : { status: 'pending', reason: null, stale: false, ...empty };
  }
  const stale = input.nowMs - v.checkedAt > input.freshnessMs;
  const prefixes = {
    checkedAt: v.checkedAt,
    expectedDigestPrefix: v.expectedDigestPrefix,
    observedDigestPrefix: v.observedDigestPrefix,
  };
  if (v.status === 'match') {
    return stale
      ? { status: 'unverifiable', reason: 'stale-receipt', stale, ...prefixes }
      : { status: 'match', reason: null, stale, ...prefixes };
  }
  if (v.status === 'mismatch') return { status: 'mismatch', reason: null, stale, ...prefixes };
  return { status: 'unverifiable', reason: v.reason, stale, ...prefixes };
}

/** Agent-runtime `degradedReasons` literals for the identity state. They reach
 *  /health `status_reasons` as `runtime.<reason>` and are deliberately NOT
 *  turn-provable: a successful turn proves the credential works, not whose
 *  it is. */
export function accountIdentityDegradedReasons(health: AccountIdentityHealth): string[] {
  if (health.status === 'mismatch') return ['credential_identity_mismatch'];
  if (health.status === 'unverifiable') return ['credential_identity_unverifiable'];
  return [];
}
