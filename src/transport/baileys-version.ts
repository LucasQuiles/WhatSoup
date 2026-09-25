import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

export type BaileysVersionTuple = [number, number, number];

/**
 * Honest provenance for the tuple actually handed to `makeWASocket`.
 *
 * S2 (bond-revocation programme, 2026-08-17). This used to be `'latest' | 'pinned'`,
 * and `resolveBaileysVersion` discarded both `isLatest` and `error` from the
 * upstream result — so a FAILED fetch, which Baileys answers with the bundled
 * fallback tuple, was reported as `source: 'latest'`. Every failure class
 * converges on one catch in the installed dependency
 * (`lib/Utils/generics.js`: DNS failure, non-OK HTTP including 429, parser drift,
 * and malformed response all return `{version: bundledFallback, isLatest: false,
 * error}`), so the label was wrong in precisely the cases an operator most needs
 * to see.
 *
 * `unknown` is deliberate and load-bearing: if the upstream result does not carry
 * `isLatest === true`, we do NOT get to claim a live fetch. Absence of a success
 * signal is not evidence of success.
 */
export type BaileysVersionSource = 'pinned' | 'live_fetch' | 'bundled_fallback' | 'unknown';

export interface ResolvedBaileysVersion {
  version: BaileysVersionTuple;
  source: BaileysVersionSource;
  /** Upstream `isLatest`, verbatim. `null` when not applicable (pinned) or absent. */
  isLatest: boolean | null;
  /**
   * Failure CLASS only — never the raw error. Upstream errors can carry a URL,
   * status text, or response body, and this value is designed to be safe for
   * structured telemetry.
   */
  fetchErrorClass: string | null;
}

export function baileysVersionLabel(version: readonly number[]): string {
  return version.join('.');
}

export function parsePinnedBaileysVersion(raw: string | undefined): BaileysVersionTuple | null {
  const value = raw?.trim();
  if (!value) return null;

  const parts = value.split('.');
  if (parts.length !== 3) {
    throw new Error('WHATSOUP_BAILEYS_VERSION must be a dotted version tuple like 2.3000.1021');
  }

  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error('WHATSOUP_BAILEYS_VERSION must contain only numeric tuple parts');
    }
    return Number(part);
  });

  if (parsed.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error('WHATSOUP_BAILEYS_VERSION parts must be safe non-negative integers');
  }

  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

/** Error class name only. Never the message — upstream embeds URLs and status text. */
function errorClassOf(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name.length > 0) {
    return error.name;
  }
  if (error === null || error === undefined) return 'unknown_error';
  return typeof error;
}

export async function resolveBaileysVersion(pinnedRaw?: string): Promise<ResolvedBaileysVersion> {
  const pinned = parsePinnedBaileysVersion(pinnedRaw);
  if (pinned) {
    return { version: pinned, source: 'pinned', isLatest: null, fetchErrorClass: null };
  }

  const result = (await fetchLatestBaileysVersion()) as {
    version: readonly number[];
    isLatest?: boolean;
    error?: unknown;
  };
  const version: BaileysVersionTuple = [
    result.version[0]!,
    result.version[1]!,
    result.version[2]!,
  ];

  // The tuple is identical in the success and fallback cases often enough that it
  // cannot be used to tell them apart — only `isLatest` can, which is why it is
  // no longer discarded.
  if (result.isLatest === true) {
    return { version, source: 'live_fetch', isLatest: true, fetchErrorClass: null };
  }
  if (result.isLatest === false) {
    return {
      version,
      source: 'bundled_fallback',
      isLatest: false,
      fetchErrorClass: errorClassOf(result.error),
    };
  }
  // Neither true nor false: an unexpected upstream shape. Report `unknown` rather
  // than assuming success — this is the branch that used to say `latest`.
  return { version, source: 'unknown', isLatest: null, fetchErrorClass: null };
}
