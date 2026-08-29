/**
 * Opaque account-identity digest — the one canonicalization shared by the
 * operator capture script (scripts/claude-account-digest.ts) and the runtime
 * identity verifier (src/runtimes/agent/providers/claude-account-identity.ts).
 *
 * The owner ratifies ONE digest per instance, captured at a known-good login;
 * the runtime digests the identity the claude CLI reports in the service
 * context and compares digests. A raw account identifier never crosses this
 * boundary in either direction: not into config, logs, alerts, health
 * payloads, tests, or receipts.
 *
 * The canonical input binds the account (email) AND the organization (orgId).
 * A digest over the email alone is guessable from a short candidate list; the
 * org UUID is not. "Same login, different org" is also a different serving
 * identity for subscription purposes, so it must read as a mismatch.
 * Dependency-light (Node builtins only) so both the config validator and the
 * runtime can share it.
 */
import { createHash } from 'node:crypto';
import { isNonEmptyString } from './type-guards.ts';

export interface AccountIdentityFields {
  email: string;
  orgId: string;
}

const CANONICAL_VERSION = 'claude-account-identity/v1';
const DIGEST_SCHEME = 'sha256:';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** Bounded correlation prefix published in logs/alerts/health; never the full digest. */
const DIGEST_PREFIX_LENGTH = 12;

export function isAccountIdentityDigest(value: unknown): value is string {
  return isNonEmptyString(value) && DIGEST_RE.test(value);
}

function canonicalField(name: keyof AccountIdentityFields, value: string): string {
  const canonical = value.trim().toLowerCase();
  if (canonical === '') throw new Error(`account identity ${name} is empty — refusing to digest an absent identity`);
  return canonical;
}

export function computeAccountIdentityDigest(fields: AccountIdentityFields): string {
  const canonical = [
    CANONICAL_VERSION,
    canonicalField('email', fields.email),
    canonicalField('orgId', fields.orgId),
  ].join('\n');
  return `${DIGEST_SCHEME}${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function accountIdentityDigestPrefix(digest: string | null): string | null {
  if (digest === null) return null;
  const hex = digest.startsWith(DIGEST_SCHEME) ? digest.slice(DIGEST_SCHEME.length) : digest;
  return hex.slice(0, DIGEST_PREFIX_LENGTH);
}
