// src/transport/auth-generation.ts
//
// S3 of the bond-revocation programme (2026-08-17): which bond generation died.
//
// `bond_created_at` was never recorded anywhere. Every age in the investigation was
// DERIVED — `q`'s "~49 days" came from the mtimes of two quarantine directories
// (`auth.bak.*`, `auth.prepair.*`) that happen to carry different identity digests.
// That derivation was defensible but it is not a receipt, and it is not repeatable:
//
//   A repo-wide search on 2026-08-17 found **no producer of those quarantine
//   directories anywhere in this codebase**. They are a side effect of external or
//   ad-hoc ops tooling, in at least SEVEN different naming conventions across hosts
//   (`auth.bak`, `auth.prepair`, `auth.relink.bak`, `auth.loggedOut.<ISO>`,
//   `auth.logged-out-<ISO>`, `auth.loggedout-<ISO>`, `auth.partialPairing.<ISO>`).
//   Nothing owns them, nothing guarantees them, and their per-name semantics are
//   not uniform.
//
// So the recurrence intervals measured from them are real observations about the
// past and a weak guarantee about future observability. This module replaces the
// dependency with a receipt the application owns.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: where a generation is genuinely unknown,
// report `null` WITH A REASON. Never derive it from auth-directory birth, from a
// credential file's mtime, or from process uptime. Those three temptations are
// named as failure criteria in the plan, and the quarantine artifacts make the
// first two look easy — which is exactly why the code must refuse.
//
// CONSEQUENCE, stated plainly because it will look like a bug otherwise: every
// bond that exists TODAY will report `no_receipt_written`. The receipt is created at
// pairing, so it can only describe generations paired from this code forward.
// Backfilling the current fleet from timestamps is precisely the derivation this
// module forbids. An honest `null` is the correct answer for pre-existing bonds.

import { config } from '../config.ts';
import type { EffectiveClientReceipt } from './effective-client-receipt.ts';
import { shortHash } from '../lib/short-hash.ts';
import {
  privateJournalPath,
  readPrivateV1JournalSync,
  writePrivateJournalSync,
} from '../lib/private-journal.ts';

const JOURNAL_FILENAME = 'auth-generation.json';
const JOURNAL_LABEL = 'auth-generation';
const DIGEST_LENGTH = 20;

/** How the generation was established. Observed, never guessed. */
export type AuthGenerationSource = 'pairing_cli';

export interface AuthGenerationReceipt {
  version: 1;
  /**
   * Pseudonymous generation identity. Derived from the hashed account identity and
   * the creation instant, so a re-pair of the same account yields a DIFFERENT id —
   * which is the property that lets a re-revocation be told from a re-emission.
   */
  generationId: string;
  /** The pairing instant. OBSERVED at the moment credentials were durably saved. */
  bondCreatedAt: string;
  source: AuthGenerationSource;
  /** Hashed account identity. A raw JID must never reach this record. */
  identityDigest: string | null;
  authRootHash: string;
  /**
   * The effective-client receipt of the process that ESTABLISHED this generation.
   *
   * This field exists because the pairing CLI is a separate, short-lived process.
   * Recording its client identity in an in-memory registry was useless in
   * production: the registry died with the process, and the only consumer is the
   * daemon that starts afterwards. There was no file, IPC, SSE payload or database
   * row carrying it across that boundary — so the receipt provably executed and
   * provably never arrived.
   *
   * Persisting it here, under the generation it describes, is the carrier. A later
   * terminal event can then compare the client that established the bond against
   * the client that was running when it died — a question that could not previously
   * be asked at all.
   *
   * `null` when the pairing client was not supplied; never synthesised.
   */
  pairingClient: EffectiveClientReceipt | null;
}

export type AuthGenerationEvidence =
  | { status: 'recorded'; version: 1; receipt: AuthGenerationReceipt }
  | {
      status: 'unavailable';
      version: 1;
      /**
       * `no_receipt_written` is the honest answer for every bond paired before this
       * module existed — distinct from a receipt that exists but cannot be read.
       * Collapsing them would turn "never recorded" into "lost", or worse, invite a
       * derived value.
       */
      reason: 'no_receipt_written' | 'unreadable' | 'malformed' | 'resolver_threw';
      /** Always null. Present and explicit so no reader infers a derivable age. */
      bondCreatedAt: null;
    };

function journalPathFor(stateRoot: string): string {
  return privateJournalPath(stateRoot, JOURNAL_FILENAME);
}

/**
 * Write the generation receipt. Call ONLY after credentials are durably persisted —
 * a generation whose credentials never landed is not a generation.
 *
 * Returns the receipt on success, or null if there is nowhere to write it. Never
 * throws: pairing must not fail because bookkeeping did.
 */
export function writeAuthGenerationReceipt(args: {
  accountJid: string | null;
  createdAtMs: number;
  source?: AuthGenerationSource;
  stateRoot?: string | null;
  authDir?: string;
  /** The client that established this generation. Persisted across the process boundary. */
  pairingClient?: EffectiveClientReceipt | null;
}): AuthGenerationReceipt | null {
  try {
    const stateRoot = args.stateRoot ?? config.stateRoot ?? null;
    if (!stateRoot) return null;
    const bondCreatedAt = new Date(args.createdAtMs).toISOString();
    const identityDigest =
      args.accountJid && args.accountJid.length > 0 && args.accountJid !== 'unknown'
        ? shortHash(args.accountJid, DIGEST_LENGTH)
        : null;
    const receipt: AuthGenerationReceipt = {
      version: 1,
      generationId: shortHash(`${identityDigest ?? 'no-identity'}:${bondCreatedAt}`, 24),
      bondCreatedAt,
      source: args.source ?? 'pairing_cli',
      identityDigest,
      authRootHash: shortHash(args.authDir ?? config.authDir, DIGEST_LENGTH),
      pairingClient: args.pairingClient ?? null,
    };
    // `v: 1` is the envelope readPrivateV1JournalSync validates.
    writePrivateJournalSync(journalPathFor(stateRoot), { v: 1, ...receipt }, JOURNAL_LABEL);
    return receipt;
  } catch {
    return null;
  }
}

function validate(value: Record<string, unknown>): AuthGenerationReceipt | null {
  const bondCreatedAt = value['bondCreatedAt'];
  const generationId = value['generationId'];
  const source = value['source'];
  const authRootHash = value['authRootHash'];
  if (typeof bondCreatedAt !== 'string' || bondCreatedAt.length === 0) return null;
  if (Number.isNaN(Date.parse(bondCreatedAt))) return null;
  if (typeof generationId !== 'string' || generationId.length === 0) return null;
  if (source !== 'pairing_cli') return null;
  if (typeof authRootHash !== 'string' || authRootHash.length === 0) return null;
  const identityDigest = value['identityDigest'];
  // The persisted pairing client is carried through opaquely: this module owns the
  // generation contract, not the client contract, and re-validating a foreign shape
  // here would duplicate ownership. A structurally wrong value surfaces to the
  // reader as-is rather than silently becoming null.
  const pairingClient = value['pairingClient'];
  return {
    version: 1,
    generationId,
    bondCreatedAt,
    source,
    identityDigest: typeof identityDigest === 'string' ? identityDigest : null,
    authRootHash,
    pairingClient:
      pairingClient && typeof pairingClient === 'object' && !Array.isArray(pairingClient)
        ? (pairingClient as EffectiveClientReceipt)
        : null,
  };
}

/** Frozen, computation-free fallbacks — see resolveAuthGenerationEvidence. */
function unavailable(
  reason: 'no_receipt_written' | 'unreadable' | 'malformed' | 'resolver_threw',
): AuthGenerationEvidence {
  return { status: 'unavailable', version: 1, reason, bondCreatedAt: null };
}
const UNAVAILABLE_THREW: AuthGenerationEvidence = Object.freeze({
  status: 'unavailable' as const,
  version: 1 as const,
  reason: 'resolver_threw' as const,
  bondCreatedAt: null,
});

/**
 * The only entry point bond-event construction should use.
 *
 * Cannot throw — `persistBondEvent` wraps its whole payload in one try/catch whose
 * only handler is a `log.warn`, so a throwing receptor would discard the terminal
 * record this programme exists to capture.
 */
export function resolveAuthGenerationEvidence(
  stateRoot: string | null = config.stateRoot ?? null,
): AuthGenerationEvidence {
  try {
    if (!stateRoot) return unavailable('no_receipt_written');
    const read = readPrivateV1JournalSync(journalPathFor(stateRoot), JOURNAL_LABEL);
    if (read.status === 'journal_unreadable') return unavailable('unreadable');
    if (read.version === 'missing') return unavailable('no_receipt_written');
    const receipt = validate(read.value);
    if (!receipt) return unavailable('malformed');
    return { status: 'recorded', version: 1, receipt };
  } catch {
    return UNAVAILABLE_THREW;
  }
}
