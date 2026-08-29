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

import { timingSafeEqual } from 'node:crypto';
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
 *  own startup on a loaded host can exceed the 5 s preflight default. */
const IDENTITY_PROBE_TIMEOUT_MS = 15_000;

export type ObservedAccountIdentity =
  | { kind: 'identity'; digest: string }
  | { kind: 'absent'; reason: 'not-logged-in' | 'identity-fields-missing' }
  | { kind: 'unparseable' };

export type AccountIdentityVerificationStatus = 'disabled' | 'match' | 'mismatch' | 'unverifiable';

export type AccountIdentityUnverifiableReason =
  | 'binary-missing'
  | 'probe-failed'
  | 'probe-threw'
  | 'not-logged-in'
  | 'identity-fields-missing'
  | 'unparseable'
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

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
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

  let binary: string | null;
  try {
    binary = (deps.getProviderBinary ?? getProviderBinary)('claude-cli');
  } catch {
    binary = null;
  }
  if (!binary) return outcome('unverifiable', 'binary-missing', null);

  let probe: BinaryAuthStatusResult;
  try {
    probe = await (deps.probeBinaryCommand ?? probeBinaryCommand)(
      binary,
      [...CLAUDE_AUTH_STATUS_ARGS],
      // env-allowed: explicit per-var allow-list scrubbed from the caller-supplied env, not passthrough
      scrubbedAuthStatusEnv(deps.env ?? process.env),
      { timeoutMs: deps.timeoutMs ?? IDENTITY_PROBE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
  } catch {
    return outcome('unverifiable', 'probe-threw', null);
  }

  const observed = parseClaudeAuthStatusIdentity(probe.output);
  if (probe.status !== 'ok') {
    // A non-zero exit that still reports a structured logged-out state is that
    // state; any other non-zero exit is a probe failure — even output that
    // looks like a valid identity is not trusted without a clean exit.
    return outcome(
      'unverifiable',
      observed.kind === 'absent' && observed.reason === 'not-logged-in' ? 'not-logged-in' : 'probe-failed',
      null,
    );
  }
  if (observed.kind === 'unparseable') return outcome('unverifiable', 'unparseable', null);
  if (observed.kind === 'absent') return outcome('unverifiable', observed.reason, null);
  return digestsEqual(observed.digest, expectedDigest)
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
