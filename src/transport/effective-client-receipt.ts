// src/transport/effective-client-receipt.ts
//
// S2 of the bond-revocation programme (2026-08-17): what the client actually was.
//
// The investigation could not answer a basic question about a revoked bond — what
// client identity did WhatsApp see? The protocol tuple was logged as a bare label,
// and everything else about the socket was invisible: browser tuple, history-sync
// behaviour, online-presence behaviour, link-preview generation. Two identical
// tuples across a revocation boundary were therefore NOT evidence of identical
// client behaviour, which is why "the tuple did not change" refuted less than it
// appeared to.
//
// TWO INDEPENDENT SOCKET PATHS construct a client, and they do not agree:
//
//   src/transport/connection.ts  the runtime connection
//   src/transport/auth.ts        the pairing CLI
//
// Both call `makeWASocket`. `connection.ts` passes
// `generateHighQualityLinkPreview: config.generateHighQualityLinkPreview`; `auth.ts`
// hard-codes `false`. Neither passes `browser`, `syncFullHistory`, or
// `markOnlineOnConnect`, so both silently inherit the library defaults — which in
// the installed dependency are `Browsers.macOS('Chrome')`, `syncFullHistory: true`
// and `markOnlineOnConnect: true` (`lib/Defaults/index.js`). A bond paired through
// the CLI and then run by the daemon has therefore presented at least one
// materially different client property, and nothing recorded it.
//
// DESIGN RULE, learned from the sock-tool factory defect fixed earlier the same
// day: the receipt is derived FROM the very object handed to `makeWASocket`, never
// assembled in parallel from the same inputs. A parallel list drifts the moment
// someone edits one side; deriving makes drift structurally impossible.
//
//   const socketConfig = { version, logger, auth, ... };
//   const receipt = buildEffectiveClientReceipt(socketConfig, resolved, 'connection');
//   const sock = makeWASocket(socketConfig);
//
// PRIVACY: this records CONFIGURATION, not credentials. `auth` is never read
// beyond noting whether it was supplied. Nothing here can carry key material, a
// JID, or a phone number.
//
// Emit as STRUCTURED FIELDS only. Never push any of this onto an alert evidence
// string: `confineAlertContent` replaces evidence with
// `{failureClass, length, correlationDigest}` unconditionally before the durable
// operator plane (#2386), so an evidence-string carrier would be silently dropped.

import type { BaileysVersionSource, ResolvedBaileysVersion } from './baileys-version.ts';

/** Which of the two socket construction paths built this client. */
export type SocketCallSite = 'connection' | 'pairing_cli';

/**
 * Whether a value was passed explicitly at the call site or inherited from the
 * library default. This distinction is the point: an inherited default is a real
 * behaviour that nobody chose and nobody could see.
 */
export type ValueProvenance = 'explicit' | 'library_default';

export interface ReceiptField<T> {
  value: T;
  provenance: ValueProvenance;
}

export interface EffectiveClientReceipt {
  version: 1;
  callSite: SocketCallSite;
  /** The exact tuple handed to makeWASocket, read back from the config object. */
  protocolVersion: string;
  protocolVersionTuple: readonly [number, number, number];
  /** Honest resolver provenance — see BaileysVersionSource. */
  protocolVersionSource: BaileysVersionSource;
  protocolVersionIsLatest: boolean | null;
  protocolVersionFetchErrorClass: string | null;
  /** Browser tuple as [platform, browser, version], or null when unreadable. */
  browser: ReceiptField<readonly string[] | null>;
  syncFullHistory: ReceiptField<boolean>;
  markOnlineOnConnect: ReceiptField<boolean>;
  generateHighQualityLinkPreview: ReceiptField<boolean>;
  /** Presence of auth material only — never its content. */
  authSupplied: boolean;
  keyStoreCacheable: boolean;
}

/**
 * The installed dependency's defaults, recorded so an inherited value is reported
 * as the concrete behaviour it produces rather than as a blank.
 *
 * These MUST be kept true to `node_modules/@whiskeysockets/baileys/lib/Defaults`.
 * `assertLibraryDefaultsUnchanged` exists so a dependency bump that moves them
 * fails a test instead of silently making every receipt wrong.
 */
export const OBSERVED_LIBRARY_DEFAULTS = Object.freeze({
  browser: Object.freeze(['Mac OS', 'Chrome', '14.4.1']) as readonly string[],
  syncFullHistory: true,
  markOnlineOnConnect: true,
  generateHighQualityLinkPreview: false,
});

/** The subset of makeWASocket config this receipt reads. */
export interface SocketConfigLike {
  version?: readonly number[];
  browser?: readonly string[];
  syncFullHistory?: boolean;
  markOnlineOnConnect?: boolean;
  generateHighQualityLinkPreview?: boolean;
  auth?: { creds?: unknown; keys?: unknown } | undefined;
}

function field<T>(supplied: T | undefined, fallback: T): ReceiptField<T> {
  return supplied === undefined
    ? { value: fallback, provenance: 'library_default' }
    : { value: supplied, provenance: 'explicit' };
}

/**
 * Build the receipt from the actual socket config.
 *
 * Reads `config` rather than re-deriving from the inputs that produced it, so the
 * receipt cannot describe a client that was not constructed.
 */
export function buildEffectiveClientReceipt(
  config: SocketConfigLike,
  resolved: ResolvedBaileysVersion,
  callSite: SocketCallSite,
): EffectiveClientReceipt {
  // Read the tuple back off the config, NOT off `resolved` — if a call site ever
  // passes something other than the resolved tuple, the receipt must show what the
  // socket got, not what the resolver said.
  const tupleSource = config.version ?? resolved.version;
  const tuple: readonly [number, number, number] = [
    Number(tupleSource[0] ?? 0),
    Number(tupleSource[1] ?? 0),
    Number(tupleSource[2] ?? 0),
  ];
  return {
    version: 1,
    callSite,
    protocolVersion: tuple.join('.'),
    protocolVersionTuple: tuple,
    protocolVersionSource: resolved.source,
    protocolVersionIsLatest: resolved.isLatest,
    protocolVersionFetchErrorClass: resolved.fetchErrorClass,
    browser: field<readonly string[] | null>(config.browser, OBSERVED_LIBRARY_DEFAULTS.browser),
    syncFullHistory: field(config.syncFullHistory, OBSERVED_LIBRARY_DEFAULTS.syncFullHistory),
    markOnlineOnConnect: field(
      config.markOnlineOnConnect,
      OBSERVED_LIBRARY_DEFAULTS.markOnlineOnConnect,
    ),
    generateHighQualityLinkPreview: field(
      config.generateHighQualityLinkPreview,
      OBSERVED_LIBRARY_DEFAULTS.generateHighQualityLinkPreview,
    ),
    authSupplied: config.auth?.creds !== undefined,
    keyStoreCacheable: config.auth?.keys !== undefined,
  };
}

/**
 * Process-wide last-known receipt, per call site.
 *
 * One slot per call site, last write wins — bounded like the actor ledger, and read
 * on every bond event.
 */
class EffectiveClientRegistry {
  private receipts = new Map<SocketCallSite, EffectiveClientReceipt>();

  record(receipt: EffectiveClientReceipt): void {
    this.receipts.set(receipt.callSite, receipt);
  }

  /** Most recent receipt for the runtime connection, else any recorded one. */
  current(): EffectiveClientReceipt | null {
    return this.receipts.get('connection') ?? this.receipts.get('pairing_cli') ?? null;
  }

  reset(): void {
    this.receipts.clear();
  }
}

export const effectiveClientRegistry = new EffectiveClientRegistry();

export type EffectiveClientEvidence =
  | { status: 'recorded'; version: 1; receipt: EffectiveClientReceipt }
  | { status: 'unavailable'; version: 1; reason: 'not_recorded' | 'resolver_threw' };

/** Frozen, computation-free fallbacks — see resolveEffectiveClientEvidence. */
const UNAVAILABLE_NOT_RECORDED: EffectiveClientEvidence = Object.freeze({
  status: 'unavailable' as const,
  version: 1 as const,
  reason: 'not_recorded' as const,
});
const UNAVAILABLE_THREW: EffectiveClientEvidence = Object.freeze({
  status: 'unavailable' as const,
  version: 1 as const,
  reason: 'resolver_threw' as const,
});

/**
 * The only entry point bond-event construction should use.
 *
 * Cannot throw, for the same reason the actor receipt cannot: `persistBondEvent`
 * wraps its whole payload in one try/catch whose only handler is a `log.warn`, so a
 * throwing receptor would discard the terminal event itself. `not_recorded` (no
 * socket built yet) is kept distinct from `resolver_threw` (the channel broke) —
 * a missing observation must never be dressed up as an observed absence.
 */
export function resolveEffectiveClientEvidence(
  registry: EffectiveClientRegistry = effectiveClientRegistry,
): EffectiveClientEvidence {
  try {
    const receipt = registry.current();
    if (!receipt) return UNAVAILABLE_NOT_RECORDED;
    return { status: 'recorded', version: 1, receipt };
  } catch {
    return UNAVAILABLE_THREW;
  }
}
