import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const ALG = 'sha256';
const HMAC_HEX = /^[0-9a-f]{64}$/i;

export interface KeyFileModeResult {
  ok: boolean;
  mode: number;
  reason?: string;
}

function compose(probeId: string, scopeId: string, expectedDoc: string, capturedAt: string): string {
  return [probeId, scopeId, expectedDoc, capturedAt]
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`)
    .join('');
}

function assertUsableKey(key: Buffer): void {
  if (key.length === 0 || key.every(isAsciiWhitespace)) {
    throw new Error('HMAC key must not be empty or whitespace-only');
  }
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

export function sign(key: Buffer, probeId: string, scopeId: string, expectedDoc: string, capturedAt: string): string {
  assertUsableKey(key);
  return createHmac(ALG, key)
    .update(compose(probeId, scopeId, expectedDoc, capturedAt), 'utf8')
    .digest('hex');
}

export function verify(
  key: Buffer,
  probeId: string,
  scopeId: string,
  expectedDoc: string,
  capturedAt: string,
  expected: string,
): boolean {
  if (!HMAC_HEX.test(expected)) return false;

  try {
    const actual = Buffer.from(sign(key, probeId, scopeId, expectedDoc, capturedAt), 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBuffer.length) return false;
    return timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

export function verifyKeyFileMode(path: string, allowed = 0o400): KeyFileModeResult {
  try {
    const stat = statSync(path);
    const mode = stat.mode & 0o777;
    if (!stat.isFile()) return { ok: false, mode, reason: 'HMAC key path is not a regular file' };
    if (mode === allowed) return { ok: true, mode };
    return { ok: false, mode, reason: `expected ${allowed.toString(8)}, found ${mode.toString(8)}` };
  } catch {
    return { ok: false, mode: 0, reason: 'HMAC key file missing or not readable' };
  }
}

export function loadKey(path: string): Buffer {
  const modeResult = verifyKeyFileMode(path);
  if (!modeResult.ok) throw new Error(`HMAC key file mode rejected: ${modeResult.reason}`);

  try {
    const key = readFileSync(path);
    assertUsableKey(key);
    return key;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('HMAC key')) throw error;
    throw new Error('HMAC key file could not be read');
  }
}
