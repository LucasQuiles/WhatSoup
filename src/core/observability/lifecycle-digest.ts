// src/core/observability/lifecycle-digest.ts
// Fleet Lifecycle Observability Standard — Contract H keyed digests (F10).
//
// Every digest exported by the lifecycle observability surfaces (scope_digest,
// condition_fingerprint, evidence_digests, manager_digest) is an HMAC-SHA256
// over a domain-separation prefix plus the value, keyed with a per-fleet secret
// that lives with fleet credentials (never in the repo, never on an exported
// surface), and carries a versioned key id (`k1:…`) for rotation. Unkeyed or
// publicly derivable hashes are nonconformant: fleet identifiers are
// phone-number-derived and enumerable, so an unkeyed hash is reversible by
// dictionary. Operators with host access re-derive digests via the key to join
// against the private store; nobody else can.
//
// Rotation is a dual-digest migration over one fleet wave: writers emit both
// the current (kN) and previous (kN-1) digests, and condition identity matches
// on EITHER, so open conditions keep their identity with no close/reopen churn.
// A reader that sees an unknown key id treats the digest as unjoinable — never
// as a new identity. This module is the digest primitive only; provisioning
// of the secret, rotation sweeps, and retirement gates live with later stages.
//
// Dark by default: nothing imports this until the `observability.fleetLifecycle`
// flag gates emission.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type DigestDomain = 'scope' | 'condition' | 'evidence' | 'manager';

const DOMAIN_PREFIX = 'whatsoup.flos.v1';
const KEY_ID_PATTERN = /^k[1-9][0-9]*$/;
const DIGEST_PATTERN = /^(k[1-9][0-9]*):([0-9a-f]{64})$/;

export interface LifecycleKey {
  /** Versioned key id, e.g. `k1`. Rendered as the digest prefix. */
  keyId: string;
  /** Per-fleet secret. Never logged, never exported. */
  secret: Buffer | string;
}

export interface LifecycleDigesterOptions extends LifecycleKey {
  /** Previous key during a rotation wave (dual emission). */
  previous?: LifecycleKey;
}

export interface DigestPair {
  current: string;
  /** Present only while a rotation wave is in progress. */
  previous?: string;
}

export interface ParsedDigest {
  keyId: string;
  hex: string;
}

export interface LifecycleDigester {
  readonly keyId: string;
  /** Keyed digest of `value` within `domain`, rendered as `<keyId>:<hex>`. */
  digest(domain: DigestDomain, value: string): string;
  /** Current digest plus the previous-key digest during a rotation wave. */
  digestPair(domain: DigestDomain, value: string): DigestPair;
  /** True when the digest's key id is one this digester can re-derive. */
  joinable(digest: string): boolean;
}

function normalizeSecret(secret: Buffer | string, label: string): Buffer {
  const buffer = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (buffer.length === 0) {
    throw new Error(`lifecycle digest ${label} secret must not be empty`);
  }
  return buffer;
}

function normalizeKeyId(keyId: string, label: string): string {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`lifecycle digest ${label} key id must match k<N> (got ${JSON.stringify(keyId)})`);
  }
  return keyId;
}

function hmacDigest(secret: Buffer, keyId: string, domain: DigestDomain, value: string): string {
  const mac = createHmac('sha256', secret);
  // Domain separation: prefix + domain + NUL + value. The NUL terminator keeps
  // `domain` and `value` from sliding into each other.
  mac.update(`${DOMAIN_PREFIX}/${domain}\0`, 'utf8');
  mac.update(value, 'utf8');
  return `${keyId}:${mac.digest('hex')}`;
}

export function parseLifecycleDigest(digest: string): ParsedDigest | null {
  if (typeof digest !== 'string') return null;
  const match = DIGEST_PATTERN.exec(digest);
  if (match === null) return null;
  return { keyId: match[1]!, hex: match[2]! };
}

function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Identity match across a rotation wave: `candidate` matches `pair` when it
 * equals the current digest OR the previous-key digest (same key id AND same
 * bytes). Different key ids never match by accident.
 */
export function digestsMatch(pair: DigestPair, candidate: string): boolean {
  const parsedCandidate = parseLifecycleDigest(candidate);
  if (parsedCandidate === null) return false;
  for (const emitted of [pair.current, pair.previous]) {
    if (emitted === undefined) continue;
    const parsed = parseLifecycleDigest(emitted);
    if (parsed === null) continue;
    if (parsed.keyId === parsedCandidate.keyId && hexEqual(parsed.hex, parsedCandidate.hex)) {
      return true;
    }
  }
  return false;
}

export function createLifecycleDigester(options: LifecycleDigesterOptions): LifecycleDigester {
  const keyId = normalizeKeyId(options.keyId, 'current');
  const secret = normalizeSecret(options.secret, 'current');
  let previous: { keyId: string; secret: Buffer } | null = null;
  if (options.previous !== undefined) {
    const previousKeyId = normalizeKeyId(options.previous.keyId, 'previous');
    if (previousKeyId === keyId) {
      throw new Error('lifecycle digest previous key id must differ from the current key id');
    }
    previous = { keyId: previousKeyId, secret: normalizeSecret(options.previous.secret, 'previous') };
  }
  const knownKeyIds = new Set([keyId, ...(previous ? [previous.keyId] : [])]);

  return {
    keyId,
    digest(domain, value) {
      return hmacDigest(secret, keyId, domain, value);
    },
    digestPair(domain, value) {
      const current = hmacDigest(secret, keyId, domain, value);
      return previous
        ? { current, previous: hmacDigest(previous.secret, previous.keyId, domain, value) }
        : { current };
    },
    joinable(digest) {
      const parsed = parseLifecycleDigest(digest);
      return parsed !== null && knownKeyIds.has(parsed.keyId);
    },
  };
}
