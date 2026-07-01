/**
 * Pairing-code mode for the WhatSoup auth CLI.
 *
 * Pairing mode is INERT by default: it engages only when WHATSOUP_PAIR_NUMBER
 * is explicitly set to a valid number. QR mode is the default and is untouched.
 *
 * The gating/masking/formatting are pure functions so they are unit-tested
 * without a live WhatsApp socket. The real pairing code travels only on the
 * stdout automation channel (consumed by the relink orchestrator); it is never
 * written to a log unmasked.
 */

export type PairNumberClass =
  | { ok: true; number: string; reason: 'ok' }
  | { ok: false; number: null; reason: 'unset' | 'invalid' };

/**
 * Classify the raw WHATSOUP_PAIR_NUMBER value.
 *  - unset/empty  -> QR mode (pairing inert)
 *  - present but not a plausible E.164 (8..15 digits) -> invalid (fail-closed)
 *  - valid        -> ok, normalized to digits only
 */
export function classifyPairNumber(raw: string | undefined | null): PairNumberClass {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return { ok: false, number: null, reason: 'unset' };
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, number: null, reason: 'invalid' };
  }
  return { ok: true, number: digits, reason: 'ok' };
}

/** Mask a pairing code for logs: keep first 2 + last 1, never the full value. */
export function maskPairingCode(code: string): string {
  const c = (code ?? '').trim();
  if (c.length <= 3) return '*'.repeat(Math.max(1, c.length));
  return c.slice(0, 2) + '*'.repeat(c.length - 3) + c.slice(-1);
}

/**
 * The stdout automation line carrying the real code to the orchestrator.
 * This is the ONLY place the unmasked code is emitted, and it is a machine
 * channel, not a log.
 */
export function pairingEmissionLine(code: string): string {
  return JSON.stringify({ event: 'pairing_code', code });
}

export type PairingGate =
  | { request: true }
  | { request: false; reason: 'unset' | 'invalid' | 'already-registered' | 'single-fire' };

/**
 * Decide whether to request a pairing code on this connection update.
 * Pure: same inputs -> same decision. Encodes the single-fire guard and the
 * clean-auth requirement (do not request when already registered).
 */
export function pairingGate(opts: {
  rawNumber: string | undefined | null;
  registered: boolean;
  alreadyRequested: boolean;
}): PairingGate {
  const cls = classifyPairNumber(opts.rawNumber);
  if (cls.reason === 'unset') return { request: false, reason: 'unset' };
  if (cls.reason === 'invalid') return { request: false, reason: 'invalid' };
  if (opts.registered) return { request: false, reason: 'already-registered' };
  if (opts.alreadyRequested) return { request: false, reason: 'single-fire' };
  return { request: true };
}
