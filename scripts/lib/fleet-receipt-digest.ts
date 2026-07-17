/**
 * Capability-identity projection + content-addressed digest for a committed
 * runtime receipt (#1867 criterion 1, guard-side half). Design:
 * `1867-runtime-proof-producer-design.md` §4 (digest), §6 (manifest
 * integration), §7.2 (guard validation).
 *
 * This module defines the receipt's **internal contract**: the exact fields
 * a receipt-capture producer must emit, and exactly how the guard reduces
 * them to a digest. The producer that WRITES receipt files is a separate,
 * later increment (design §9 D5) -- this module only fixes the shape the
 * guard reads and the digest it recomputes, so that producer has a concrete
 * target to conform to.
 *
 * Mirrors `fleet-roster-inventory.ts`'s `roster_identity`/`roster_digest`
 * pattern exactly, and for the same reason: hash a normalized *projection*
 * of only the identity-stable fields, never the raw receipt bundle. A live
 * instance's captured state is never byte-identical between two captures of
 * a healthy, unchanged instance (uptime, generated-at, fallback turn/probe
 * counters all move on their own); hashing the full bundle would produce a
 * new digest on every single capture, which breaks "stable/reproducible" and
 * -- for a committed receipt -- would force re-committing the manifest on
 * every capture cycle. The fix is the same one `roster_identity` already
 * uses: define the identity-tagged subset and hash only that.
 *
 * Included in the projection (hashed) -- the identity-tagged fields named in
 * design §2.1/§4: `commit`, `schemaMigration`, `provider`,
 * `modelUsabilityStatus`, the fallback chain's `provider`/`model`/`eligible`
 * shape (not its turn/probe counters), and the drift-check job's `ok`
 * boolean. Excluded (carried in the receipt file, never hashed): `uptime`,
 * `generatedAt`/timestamps, fallback turn/probe counters, and any other
 * volatile field the receipt file may also contain -- this projection reads
 * only the fields below and ignores everything else present on the object.
 *
 * Bytes hashed: `sha256(pyJsonStringify(projection))`, reusing the exact
 * canonical JSON encoder `fleet-roster-inventory.ts` uses for
 * `roster_digest` (`json.dumps(value, sort_keys=True, separators=(",",
 * ":"), ensure_ascii=True)`, byte-for-byte), so a later Python producer that
 * serializes the same projection with the stdlib `json.dumps` call of the
 * same shape computes an identical digest.
 *
 * Do not hand-roll a second JSON encoder here -- import `pyJsonStringify`
 * from `fleet-roster-inventory.ts`.
 */
import { createHash } from 'node:crypto';

import { isRecord } from '../../src/lib/type-guards.ts';
import { pyJsonStringify } from './fleet-roster-inventory.ts';

/** Raised when a receipt bundle cannot be reduced to the capability-identity
 * projection because it is not an object, or one of the identity-tagged
 * fields is missing or ill-typed. Callers treat this as fail-closed: a
 * receipt file the guard cannot project must not be silently treated as a
 * digest match (mirrors `RosterPortError` in `fleet-roster-inventory.ts`). */
export class ReceiptDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptDigestError';
  }
}

/** Identity-only slice of a receipt's fallback chain entry: `provider`,
 * `model`, and `eligible` are capability-relevant (a real config/eligibility
 * fact); any turn/probe counters or timestamps on the same entry are
 * volatile and deliberately not part of this shape. */
export interface ReceiptFallbackChainIdentity {
  provider: string;
  model: string;
  eligible: boolean;
}

/** The capability-identity projection itself -- the only fields hashed into
 * a receipt's digest. Field names match the row-level `releaseIdentity`
 * shape (`commit`, `schemaMigration`, `provider`) already validated in
 * `check-fleet-bot-hardening-parity.ts`, so a later cross-check increment
 * (`release-identity-receipt-mismatch`, design §7.3, deferred) can diff them
 * directly without a name-mapping step. */
export interface ReceiptCapabilityIdentity {
  commit: string;
  schemaMigration: number;
  provider: string;
  modelUsabilityStatus: string;
  fallbackChain: ReceiptFallbackChainIdentity[];
  driftOk: boolean;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReceiptDigestError(`receipt.${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Reduce a receipt bundle (parsed JSON of a receipt file referenced by a
 * manifest row's `receipt.path`) to its capability-identity projection.
 * Throws `ReceiptDigestError` fail-closed when the bundle is not an object
 * or any identity-tagged field is missing/ill-typed -- a receipt the guard
 * cannot project is never silently treated as matching.
 */
export function receiptCapabilityIdentity(data: unknown): ReceiptCapabilityIdentity {
  if (!isRecord(data)) {
    throw new ReceiptDigestError('receipt must be a JSON object');
  }

  const commit = requireNonEmptyString(data['commit'], 'commit');
  const provider = requireNonEmptyString(data['provider'], 'provider');
  const modelUsabilityStatus = requireNonEmptyString(data['modelUsabilityStatus'], 'modelUsabilityStatus');

  const schemaMigration = data['schemaMigration'];
  if (typeof schemaMigration !== 'number' || !Number.isInteger(schemaMigration) || schemaMigration < 0) {
    throw new ReceiptDigestError('receipt.schemaMigration must be a non-negative integer');
  }

  const rawFallbackChain = data['fallbackChain'];
  if (!Array.isArray(rawFallbackChain)) {
    throw new ReceiptDigestError('receipt.fallbackChain must be an array');
  }
  const fallbackChain: ReceiptFallbackChainIdentity[] = rawFallbackChain.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ReceiptDigestError(`receipt.fallbackChain[${index}] must be an object`);
    }
    const entryProvider = entry['provider'];
    const entryModel = entry['model'];
    const entryEligible = entry['eligible'];
    if (typeof entryProvider !== 'string') {
      throw new ReceiptDigestError(`receipt.fallbackChain[${index}].provider must be a string`);
    }
    if (typeof entryModel !== 'string') {
      throw new ReceiptDigestError(`receipt.fallbackChain[${index}].model must be a string`);
    }
    if (typeof entryEligible !== 'boolean') {
      throw new ReceiptDigestError(`receipt.fallbackChain[${index}].eligible must be a boolean`);
    }
    return { provider: entryProvider, model: entryModel, eligible: entryEligible };
  });

  const driftCheck = data['driftCheck'];
  if (!isRecord(driftCheck) || typeof driftCheck['ok'] !== 'boolean') {
    throw new ReceiptDigestError('receipt.driftCheck.ok must be a boolean');
  }

  return {
    commit,
    schemaMigration,
    provider,
    modelUsabilityStatus,
    fallbackChain,
    driftOk: driftCheck['ok'],
  };
}

/**
 * `sha256(pyJsonStringify(receiptCapabilityIdentity(data)))`, hex digest with
 * no `sha256:` prefix (callers that compare against a manifest row's
 * `receipt.digest` field, which does carry the prefix, prepend it
 * themselves) -- same call shape as `fleet-roster-inventory.ts`'s
 * `rosterDigest`. Throws `ReceiptDigestError` fail-closed, propagated from
 * `receiptCapabilityIdentity`, when the bundle cannot be projected.
 */
export function receiptCapabilityDigest(data: unknown): string {
  const identity = receiptCapabilityIdentity(data);
  const material = pyJsonStringify(identity);
  return createHash('sha256').update(Buffer.from(material, 'utf8')).digest('hex');
}
