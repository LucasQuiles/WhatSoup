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
// TWO INDEPENDENT SOCKET PATHS construct a client, and nothing reconciles them:
//
//   src/transport/connection.ts  the runtime connection
//   src/transport/auth.ts        the pairing CLI
//
// Both call `makeWASocket`. `connection.ts` passes
// `generateHighQualityLinkPreview: config.generateHighQualityLinkPreview`; `auth.ts`
// hard-codes `false`. Neither passes `browser`, `syncFullHistory`, or
// `markOnlineOnConnect`, so both silently inherit the library defaults — which in
// the installed dependency are `Browsers.macOS('Chrome')`, `syncFullHistory: true`
// and `markOnlineOnConnect: true` (`lib/Defaults/index.js`).
//
// PRECISELY: the two paths are independently maintained and CAN diverge on any
// field, with nothing detecting it. They are not currently known to diverge for
// `q` — the runtime config defaults `generateHighQualityLinkPreview` to false, `q`
// does not override it, and the pairing CLI passes false, so on the one field that
// differs in FORM the observed values AGREE. The defect is the unreconciled
// structure plus the total absence of a record, not a demonstrated difference.
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
// SCOPE — what this receipt does NOT record. The design also named the Baileys
// package/build hash, automatic session recreation, and transaction settings. None
// of those are captured here, so this is a PARTIAL client identity, not the whole
// of it. Treat an equal receipt across two connections as "these recorded fields
// matched", never as "the clients were identical".
//
// PRIVACY: this records CONFIGURATION, not credentials. `auth` is never read
// beyond noting whether it was supplied. Nothing here can carry key material, a
// JID, or a phone number.
//
// Emit as STRUCTURED FIELDS only. Never push any of this onto an alert evidence
// string: `confineAlertContent` replaces evidence with
// `{failureClass, length, correlationDigest}` unconditionally before the durable
// operator plane (#2386), so an evidence-string carrier would be silently dropped.

import { isRecord } from '../lib/type-guards.ts';
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
  /** Whether the applied tuple is the tuple whose resolver provenance follows. */
  protocolVersionResolverMatch: boolean;
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
  version: readonly [number, number, number];
  browser?: readonly string[];
  syncFullHistory?: boolean;
  markOnlineOnConnect?: boolean;
  generateHighQualityLinkPreview?: boolean;
  auth?: { creds?: unknown; keys?: unknown } | undefined;
}

const RECEIPT_KEYS = new Set([
  'version',
  'callSite',
  'protocolVersion',
  'protocolVersionTuple',
  'protocolVersionResolverMatch',
  'protocolVersionSource',
  'protocolVersionIsLatest',
  'protocolVersionFetchErrorClass',
  'browser',
  'syncFullHistory',
  'markOnlineOnConnect',
  'generateHighQualityLinkPreview',
  'authSupplied',
  'keyStoreCacheable',
]);
const FIELD_KEYS = new Set(['value', 'provenance']);
const MAX_RECEIPT_STRING_LENGTH = 256;

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RECEIPT_STRING_LENGTH;
}

function projectBooleanField(value: unknown, libraryDefault: boolean): ReceiptField<boolean> | null {
  if (!isRecord(value) || !hasExactKeys(value, FIELD_KEYS)) return null;
  const fieldValue = value['value'];
  const provenance = value['provenance'];
  if (typeof fieldValue !== 'boolean') return null;
  if (provenance !== 'explicit' && provenance !== 'library_default') return null;
  if (provenance === 'library_default' && fieldValue !== libraryDefault) return null;
  return { value: fieldValue, provenance };
}

function projectBrowserField(value: unknown): ReceiptField<readonly string[] | null> | null {
  if (!isRecord(value) || !hasExactKeys(value, FIELD_KEYS)) return null;
  const fieldValue = value['value'];
  const provenance = value['provenance'];
  if (provenance !== 'explicit' && provenance !== 'library_default') return null;
  if (
    fieldValue !== null &&
    (!Array.isArray(fieldValue) ||
      fieldValue.length !== 3 ||
      !fieldValue.every(isBoundedString))
  ) return null;
  if (
    provenance === 'library_default' &&
    (!Array.isArray(fieldValue) ||
      fieldValue.some((part, index) => part !== OBSERVED_LIBRARY_DEFAULTS.browser[index]))
  ) return null;
  return { value: fieldValue === null ? null : [...fieldValue], provenance };
}

/**
 * Validate and project persisted effective-client data into its bounded owned shape.
 * Unknown keys are rejected rather than stripped so a future or corrupted nested
 * payload cannot be mistaken for the contract this process understands.
 */
export function projectEffectiveClientReceipt(value: unknown): EffectiveClientReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return null;
  if (value['version'] !== 1) return null;
  const callSite = value['callSite'];
  if (callSite !== 'connection' && callSite !== 'pairing_cli') return null;

  let tuple: readonly [number, number, number];
  try {
    tuple = requireAppliedVersionTuple(value['protocolVersionTuple']);
  } catch {
    return null;
  }
  const protocolVersion = value['protocolVersion'];
  if (!isBoundedString(protocolVersion) || protocolVersion !== tuple.join('.')) return null;

  const resolverMatch = value['protocolVersionResolverMatch'];
  if (typeof resolverMatch !== 'boolean') return null;
  const source = value['protocolVersionSource'];
  if (!['pinned', 'live_fetch', 'bundled_fallback', 'unknown'].includes(source as string)) return null;
  const isLatest = value['protocolVersionIsLatest'];
  const fetchErrorClass = value['protocolVersionFetchErrorClass'];
  const provenanceConsistent = resolverMatch
    ? (source === 'pinned' && isLatest === null && fetchErrorClass === null) ||
      (source === 'live_fetch' && isLatest === true && fetchErrorClass === null) ||
      (source === 'bundled_fallback' && isLatest === false && isBoundedString(fetchErrorClass)) ||
      (source === 'unknown' && isLatest === null && fetchErrorClass === null)
    : source === 'unknown' && isLatest === null && fetchErrorClass === null;
  if (!provenanceConsistent) return null;

  const browser = projectBrowserField(value['browser']);
  const syncFullHistory = projectBooleanField(
    value['syncFullHistory'],
    OBSERVED_LIBRARY_DEFAULTS.syncFullHistory,
  );
  const markOnlineOnConnect = projectBooleanField(
    value['markOnlineOnConnect'],
    OBSERVED_LIBRARY_DEFAULTS.markOnlineOnConnect,
  );
  const generateHighQualityLinkPreview = projectBooleanField(
    value['generateHighQualityLinkPreview'],
    OBSERVED_LIBRARY_DEFAULTS.generateHighQualityLinkPreview,
  );
  if (!browser || !syncFullHistory || !markOnlineOnConnect || !generateHighQualityLinkPreview) {
    return null;
  }
  if (typeof value['authSupplied'] !== 'boolean' || typeof value['keyStoreCacheable'] !== 'boolean') {
    return null;
  }

  return {
    version: 1,
    callSite,
    protocolVersion,
    protocolVersionTuple: tuple,
    protocolVersionResolverMatch: resolverMatch,
    protocolVersionSource: source as BaileysVersionSource,
    protocolVersionIsLatest: isLatest as boolean | null,
    protocolVersionFetchErrorClass: fetchErrorClass as string | null,
    browser,
    syncFullHistory,
    markOnlineOnConnect,
    generateHighQualityLinkPreview,
    authSupplied: value['authSupplied'],
    keyStoreCacheable: value['keyStoreCacheable'],
  };
}

function requireAppliedVersionTuple(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((part) =>
      typeof part === 'number' && Number.isSafeInteger(part) && part >= 0
    )
  ) {
    throw new TypeError('effective client receipt requires an exact three-integer version tuple');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
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
  const tuple = requireAppliedVersionTuple(config.version);
  const protocolVersionResolverMatch =
    tuple[0] === resolved.version[0] &&
    tuple[1] === resolved.version[1] &&
    tuple[2] === resolved.version[2];
  return {
    version: 1,
    callSite,
    protocolVersion: tuple.join('.'),
    protocolVersionTuple: tuple,
    protocolVersionResolverMatch,
    protocolVersionSource: protocolVersionResolverMatch ? resolved.source : 'unknown',
    protocolVersionIsLatest: protocolVersionResolverMatch ? resolved.isLatest : null,
    protocolVersionFetchErrorClass: protocolVersionResolverMatch ? resolved.fetchErrorClass : null,
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
