import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKey, sign, verify, verifyKeyFileMode } from '../src/hmac.ts';

const KEY = Buffer.from('a'.repeat(64), 'utf8');
const OTHER_KEY = Buffer.from('b'.repeat(64), 'utf8');
const DOC = '{"a":1}';
const CAPTURED_AT = '2026-05-08T00:00:00Z';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(contents = 'test-key-material'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-hmac-'));
  dirs.push(dir);
  const path = join(dir, 'key');
  writeFileSync(path, contents, { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

describe('hmac', () => {
  it('round-trips sign and verify on identical input', () => {
    const sig = sign(KEY, 'probe.id', 'host', DOC, CAPTURED_AT);

    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verify(KEY, 'probe.id', 'host', DOC, CAPTURED_AT, sig)).toBe(true);
  });

  it('rejects a wrong key', () => {
    const sig = sign(KEY, 'probe.id', 'host', DOC, CAPTURED_AT);

    expect(verify(OTHER_KEY, 'probe.id', 'host', DOC, CAPTURED_AT, sig)).toBe(false);
  });

  it('rejects a tampered baseline doc', () => {
    const sig = sign(KEY, 'probe.id', 'host', DOC, CAPTURED_AT);

    expect(verify(KEY, 'probe.id', 'host', '{"a":2}', CAPTURED_AT, sig)).toBe(false);
  });

  it('rejects a changed timestamp', () => {
    const sig = sign(KEY, 'probe.id', 'host', DOC, CAPTURED_AT);

    expect(verify(KEY, 'probe.id', 'host', DOC, '2026-05-08T00:00:01Z', sig)).toBe(false);
  });

  it('rejects a changed scope_id', () => {
    const sig = sign(KEY, 'probe.id', 'host-a', DOC, CAPTURED_AT);

    expect(verify(KEY, 'probe.id', 'host-b', DOC, CAPTURED_AT, sig)).toBe(false);
  });

  it('rejects a changed probe_id', () => {
    const sig = sign(KEY, 'probe.a', 'host', DOC, CAPTURED_AT);

    expect(verify(KEY, 'probe.b', 'host', DOC, CAPTURED_AT, sig)).toBe(false);
  });

  it('binds fields without delimiter ambiguity', () => {
    const sig = sign(KEY, 'probe id', 'scope', 'doc', 'captured');

    expect(verify(KEY, 'probe', 'id scope', 'doc', 'captured', sig)).toBe(false);
    expect(verify(KEY, 'probe id', 'scope doc', 'captured', '', sig)).toBe(false);
  });

  it('returns false for malformed expected HMAC strings', () => {
    const sig = sign(KEY, 'probe.id', 'host', DOC, CAPTURED_AT);

    expect(verify(KEY, 'probe.id', 'host', DOC, CAPTURED_AT, `${sig.slice(0, 63)}z`)).toBe(false);
    expect(verify(KEY, 'probe.id', 'host', DOC, CAPTURED_AT, 'not-hex')).toBe(false);
    expect(verify(KEY, 'probe.id', 'host', DOC, CAPTURED_AT, sig.slice(0, 62))).toBe(false);
  });

  it('rejects empty and whitespace-only keys', () => {
    expect(() => sign(Buffer.alloc(0), 'probe.id', 'host', DOC, CAPTURED_AT)).toThrow(/HMAC key/);
    expect(() => sign(Buffer.from('   \n\t'), 'probe.id', 'host', DOC, CAPTURED_AT)).toThrow(/HMAC key/);
  });

  it('verify returns false instead of throwing for empty key input', () => {
    const sig = sign(KEY, 'probe.id', 'host', DOC, CAPTURED_AT);

    expect(verify(Buffer.alloc(0), 'probe.id', 'host', DOC, CAPTURED_AT, sig)).toBe(false);
  });

  it('verifyKeyFileMode accepts 0400 and rejects 0404', () => {
    const path = tempFile();

    expect(verifyKeyFileMode(path)).toEqual({ ok: true, mode: 0o400 });

    chmodSync(path, 0o404);
    const result = verifyKeyFileMode(path);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe(0o404);
    expect(result.reason).toContain('expected 400');
  });

  it('verifyKeyFileMode reports a missing file safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-hmac-'));
    dirs.push(dir);
    const result = verifyKeyFileMode(join(dir, 'missing-key'));

    expect(result.ok).toBe(false);
    expect(result.mode).toBe(0);
    expect(result.reason).toMatch(/not readable|missing/);
  });

  it('loadKey accepts 0400 key files', () => {
    const path = tempFile('loaded-key');

    expect(loadKey(path)).toEqual(Buffer.from('loaded-key'));
  });

  it('loadKey rejects widened key files without exposing content', () => {
    const path = tempFile('do-not-leak-this');
    chmodSync(path, 0o404);

    expect(() => loadKey(path)).toThrow(/HMAC key file mode rejected/);
    expect(() => loadKey(path)).not.toThrow(/do-not-leak-this/);
  });

  it('loadKey rejects missing files safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-hmac-'));
    dirs.push(dir);

    expect(() => loadKey(join(dir, 'missing-key'))).toThrow(/HMAC key file/);
  });
});
