// src/transport/bond-actor-receipt.ts
//
// S1 of the bond-revocation programme (2026-08-17): who or what asked for it.
//
// Every bond event used to carry the literal `ownerEvidence: { status:
// 'not_recorded' }` — a constant with no consumer and no type, written on every
// lifecycle event. When a WhatsApp companion bond was revoked, the fleet could
// establish the mechanism (401 / `conflict device_removed`) and never the
// initiating actor, because nothing joined a local control-plane action onto the
// resulting terminal event.
//
// WhatsApp's `device_removed` node carries no actor attribution, so this module
// cannot identify a server-side initiator. What it can do is make the LOCAL side
// of the question answerable, in both directions:
//
//   * a local path intentionally requested device removal  -> recorded, with route
//   * no local path did                                    -> `unattributed`, which
//     is real evidence, not a blank
//
// That negative is precisely what excluded the MCP `logout` tool for `q`: its
// tool-call ledger held 1,235 journaled calls and zero logouts. This module gives
// that reasoning a durable home on the event itself instead of an after-the-fact
// query.
//
// THREE states, and the third is the reason the type is shaped this way:
//
//   consulted    the channel was read; `bondRemovalRequest: null` means nothing
//                local asked for removal.
//   unavailable  the channel could NOT be read. Never report this as
//                `unattributed` — that converts "we did not look" into "nothing
//                was there", the proxy promotion the plan's P7.3 forbids.
//
// KNOWN LIMIT: only surfaces that call into this ledger can be attributed. The
// MCP seam reports here; the fleet server's successful-request audit trail does
// not exist yet, and when it lands it lands in main's `src/fleet`, while the
// RUNNING fleet plane is `WhatSoup-runtime-validation` @ c06e3032. So a
// fleet-API-initiated action against the live estate still resolves
// `unattributed` after this change. Do not read `unattributed` as "no API did
// it" for the live fleet — read it as "no reporting surface recorded it".

import { shortHash } from '../lib/short-hash.ts';

/**
 * The control-plane surface that initiated an action. OBSERVABLE: it is the code
 * path that called in, not an interpretation of intent.
 */
export type BondActorRoute = 'mcp' | 'fleet_api' | 'pairing_cli' | 'watchdog' | 'autonomous';

/**
 * The plan's approved actor taxonomy. DERIVED from route plus the presence of an
 * actor identity — see `deriveActorClass`. Both this and the raw `route` are
 * recorded so the derivation stays auditable and the observable survives if the
 * mapping is later judged wrong.
 */
export type BondActorClass = 'operator' | 'api' | 'scheduler' | 'autonomous' | 'unattributed';

/** Effect class of a generic control-plane action, for reader context only. */
export type ControlPlaneEffect = 'read_only' | 'external' | 'unknown';

/** A local path intentionally requested removal of this companion device. */
export interface BondRemovalRequestReceipt {
  route: BondActorRoute;
  /** Stable action label, e.g. `mcp_tool:logout`. Never free-form evidence text. */
  action: string;
  /** Pseudonymous request identity (durability row, HTTP request id, …). */
  requestIdHash: string | null;
  /** Pseudonymous actor identity. Raw JIDs never enter this record. */
  actorIdentityHash: string | null;
  requestedAt: string;
  ageMs: number;
}

/**
 * The most recent admitted control-plane action of ANY kind. Temporal context
 * only — deliberately kept in its own field so a read-only `list_chats` that
 * happened to precede a revocation can never be mistaken for an attribution.
 */
export interface ControlPlaneActionReceipt {
  route: BondActorRoute;
  action: string;
  effect: ControlPlaneEffect;
  requestIdHash: string | null;
  actorIdentityHash: string | null;
  observedAt: string;
  ageMs: number;
}

export type BondOwnerEvidence =
  | {
      status: 'consulted';
      /** Contract version, so a reader can tell this from the old literal. */
      version: 1;
      resolvedAt: string;
      /**
       * `unattributed` whenever `bondRemovalRequest` is null. Never synthesised
       * from the generic action below, and never a guess.
       */
      actorClass: BondActorClass;
      bondRemovalRequest: BondRemovalRequestReceipt | null;
      lastControlPlaneAction: ControlPlaneActionReceipt | null;
      /**
       * Fixed. `lastControlPlaneAction` establishes ordering in time and nothing
       * else; this field says so on the record rather than in a doc no reader of
       * the NDJSON will have.
       */
      causalRelation: 'temporal_only';
    }
  | {
      status: 'unavailable';
      version: 1;
      reason: 'resolver_threw' | 'ledger_absent';
      resolvedAt: string | null;
    };

export interface BondRemovalRequestInput {
  route: BondActorRoute;
  action: string;
  actorIdentity: string | null;
  requestId: string | null;
}

export interface ControlPlaneActionInput extends BondRemovalRequestInput {
  effect: ControlPlaneEffect;
}

const IDENTITY_HASH_LENGTH = 20;

function hashOrNull(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  return shortHash(value, IDENTITY_HASH_LENGTH);
}

/**
 * route + actor identity -> the plan's actor class.
 *
 * Stated as a table rather than inline logic because it is the one interpretive
 * step in this module, and a reviewer should be able to disagree with it without
 * reading control flow. An `mcp` call carrying an actor identity is an operator
 * acting through an API surface; the same call without one is an unattended API
 * caller, which is a materially different thing to see next to a revocation.
 */
function deriveActorClass(route: BondActorRoute, hasActorIdentity: boolean): BondActorClass {
  switch (route) {
    case 'mcp':
      return hasActorIdentity ? 'operator' : 'api';
    case 'pairing_cli':
      return 'operator';
    case 'fleet_api':
      return 'api';
    case 'watchdog':
      return 'scheduler';
    case 'autonomous':
      return 'autonomous';
  }
}

/**
 * Bounded, in-process actor ledger: exactly one slot per kind, last write wins.
 *
 * No arrays and no history — this is written on a hot path (every admitted tool
 * call) and read on every bond event, so it must not accumulate. Durable history
 * already exists in the tool-call durability ledger; this is only the join.
 *
 * Deliberately NOT time-expiring. Dropping an old record would destroy evidence;
 * `ageMs` is reported instead so the reader judges relevance.
 */
export class BondActorLedger {
  private removalRequest: { input: BondRemovalRequestInput; atMs: number } | null = null;
  private lastAction: { input: ControlPlaneActionInput; atMs: number } | null = null;

  /**
   * Record that a local path is about to ask WhatsApp to remove this companion
   * device. Call this BEFORE issuing the request: a receipt written afterwards
   * is lost precisely when the request succeeds and the socket dies.
   */
  recordBondRemovalRequest(input: BondRemovalRequestInput, nowMs: number = Date.now()): void {
    this.removalRequest = { input, atMs: nowMs };
    // A removal request is also the most recent control-plane action.
    this.lastAction = { input: { ...input, effect: 'external' }, atMs: nowMs };
  }

  /** Record any admitted control-plane action. Temporal context only. */
  recordControlPlaneAction(input: ControlPlaneActionInput, nowMs: number = Date.now()): void {
    this.lastAction = { input, atMs: nowMs };
  }

  /** Test/boot hygiene: drop both slots. */
  reset(): void {
    this.removalRequest = null;
    this.lastAction = null;
  }

  resolve(nowMs: number = Date.now()): BondOwnerEvidence {
    const removal = this.removalRequest;
    const action = this.lastAction;
    const removalActorHash = removal ? hashOrNull(removal.input.actorIdentity) : null;
    return {
      status: 'consulted',
      version: 1,
      resolvedAt: new Date(nowMs).toISOString(),
      actorClass: removal
        ? deriveActorClass(removal.input.route, removalActorHash !== null)
        : 'unattributed',
      bondRemovalRequest: removal
        ? {
            route: removal.input.route,
            action: removal.input.action,
            requestIdHash: hashOrNull(removal.input.requestId),
            actorIdentityHash: removalActorHash,
            requestedAt: new Date(removal.atMs).toISOString(),
            ageMs: Math.max(0, nowMs - removal.atMs),
          }
        : null,
      lastControlPlaneAction: action
        ? {
            route: action.input.route,
            action: action.input.action,
            effect: action.input.effect,
            requestIdHash: hashOrNull(action.input.requestId),
            actorIdentityHash: hashOrNull(action.input.actorIdentity),
            observedAt: new Date(action.atMs).toISOString(),
            ageMs: Math.max(0, nowMs - action.atMs),
          }
        : null,
      causalRelation: 'temporal_only',
    };
  }
}

export function createBondActorLedger(): BondActorLedger {
  return new BondActorLedger();
}

/** Process-wide ledger. One instance per bot process, like `config`. */
export const bondActorLedger = new BondActorLedger();

/**
 * Frozen literal, built at module load. The fallback below must be incapable of
 * throwing, so it performs no computation at all — not even a Date conversion,
 * which throws on a NaN clock.
 */
const UNAVAILABLE_RESOLVER_THREW: BondOwnerEvidence = Object.freeze({
  status: 'unavailable' as const,
  version: 1 as const,
  reason: 'resolver_threw' as const,
  resolvedAt: null,
});

const UNAVAILABLE_LEDGER_ABSENT: BondOwnerEvidence = Object.freeze({
  status: 'unavailable' as const,
  version: 1 as const,
  reason: 'ledger_absent' as const,
  resolvedAt: null,
});

/**
 * The ONLY entry point callers should use.
 *
 * `persistBondEvent` builds its entire payload inside a single try/catch whose
 * only handler is a `log.warn`. An exception raised while resolving this receipt
 * would therefore discard the whole bond event — including the terminal
 * `device_removed` record that this programme exists to capture. So the receipt
 * degrades to `unavailable` and never propagates a throw.
 *
 * `unavailable` is a deliberately different state from `unattributed`: one means
 * the channel could not be read, the other that it was read and was empty.
 */
export function resolveBondOwnerEvidence(
  ledger: BondActorLedger | null = bondActorLedger,
  nowMs: number = Date.now(),
): BondOwnerEvidence {
  try {
    if (!ledger) return UNAVAILABLE_LEDGER_ABSENT;
    return ledger.resolve(nowMs);
  } catch {
    return UNAVAILABLE_RESOLVER_THREW;
  }
}
