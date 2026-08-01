// tests/lib/process-lock-zod-equivalence.test.ts
//
// Equivalence net for Refs #2203 (tranche 3, Tier A): the exported
// `readProcessLockPayload` guard in `src/lib/process-lock.ts` moves its
// pid/token/startedAt shape-validation ladder to a Zod schema. The verbatim
// pre-conversion ladder is kept below as the reference implementation;
// every case asserts the reference verdict AND the live export's verdict,
// so the conversion cannot widen or narrow the accepted value space.
// `readProcessLockPayload` is itself the public seam, so cases write a raw
// lock file and call it directly.
//
// `bootId`'s permissive-drop behavior (a wrong-typed bootId never rejects
// the whole payload, it is just silently omitted from the return value) is
// NOT part of the shape-validation ladder that converts — it stays a manual
// conditional spread in the source, exactly as before — so its cases here
// assert the field is present/absent, not accepted/rejected.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessLockPayload, type ProcessLockPayload } from '../../src/lib/process-lock.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize this — it defines the value space the Zod schema must
// reproduce exactly.
function referenceReadProcessLockPayload(fileContents: string): ProcessLockPayload | null {
  try {
    const parsed = JSON.parse(fileContents) as Partial<ProcessLockPayload>;
    if (
      typeof parsed.pid !== 'number'
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.token !== 'string'
      || typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      token: parsed.token,
      startedAt: parsed.startedAt,
      ...(typeof parsed.bootId === 'string' ? { bootId: parsed.bootId } : {}),
    };
  } catch {
    return null;
  }
}

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function writeLockFile(contents: string): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'process-lock-zod-equiv-'));
  const lockPath = join(tmpRoot, 'bot.lock');
  writeFileSync(lockPath, contents, 'utf8');
  return lockPath;
}

interface Case {
  name: string;
  contents: string;
  accepted: boolean;
}

const cases: Case[] = [
  // Accepted shapes.
  { name: 'minimal valid payload', contents: JSON.stringify({ pid: 1234, token: 't', startedAt: '2026-01-01T00:00:00.000Z' }), accepted: true },
  { name: 'pid = 1 (smallest positive)', contents: JSON.stringify({ pid: 1, token: 't', startedAt: 's' }), accepted: true },
  { name: 'pid = Number.MAX_SAFE_INTEGER', contents: JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: 't', startedAt: 's' }), accepted: true },
  { name: 'token empty string (ladder only checks typeof)', contents: JSON.stringify({ pid: 1, token: '', startedAt: 's' }), accepted: true },
  { name: 'startedAt empty string (ladder only checks typeof)', contents: JSON.stringify({ pid: 1, token: 't', startedAt: '' }), accepted: true },
  { name: 'startedAt arbitrary non-ISO string', contents: JSON.stringify({ pid: 1, token: 't', startedAt: 'not a date' }), accepted: true },
  { name: 'with valid bootId', contents: JSON.stringify({ pid: 1, token: 't', startedAt: 's', bootId: 'boot-1' }), accepted: true },
  { name: 'extra unknown top-level key tolerated', contents: JSON.stringify({ pid: 1, token: 't', startedAt: 's', extra: 99 }), accepted: true },
  // pid rejections.
  { name: 'pid missing', contents: JSON.stringify({ token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid null', contents: JSON.stringify({ pid: null, token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid wrong type (string)', contents: JSON.stringify({ pid: '1234', token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid = 0 (would target a process group)', contents: JSON.stringify({ pid: 0, token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid negative', contents: JSON.stringify({ pid: -5, token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid fractional', contents: JSON.stringify({ pid: 1.5, token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid unsafe integer (2**60) trap case', contents: JSON.stringify({ pid: 2 ** 60, token: 't', startedAt: 's' }), accepted: false },
  { name: 'pid NaN literal (unquoted, invalid JSON token — parse-error path)', contents: '{"pid":NaN,"token":"t","startedAt":"s"}', accepted: false },
  // token rejections.
  { name: 'token missing', contents: JSON.stringify({ pid: 1, startedAt: 's' }), accepted: false },
  { name: 'token null', contents: JSON.stringify({ pid: 1, token: null, startedAt: 's' }), accepted: false },
  { name: 'token wrong type (number)', contents: JSON.stringify({ pid: 1, token: 42, startedAt: 's' }), accepted: false },
  // startedAt rejections.
  { name: 'startedAt missing', contents: JSON.stringify({ pid: 1, token: 't' }), accepted: false },
  { name: 'startedAt null', contents: JSON.stringify({ pid: 1, token: 't', startedAt: null }), accepted: false },
  { name: 'startedAt wrong type (number)', contents: JSON.stringify({ pid: 1, token: 't', startedAt: 123 }), accepted: false },
  // Top-level rejections.
  { name: 'top-level null', contents: 'null', accepted: false },
  { name: 'top-level array', contents: '[]', accepted: false },
  { name: 'top-level string', contents: JSON.stringify('hello'), accepted: false },
  { name: 'top-level number', contents: '42', accepted: false },
  { name: 'invalid JSON (parse error)', contents: '{not valid json', accepted: false },
  { name: 'empty file (parse error)', contents: '', accepted: false },
];

describe('readProcessLockPayload shape-validation equivalence', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, () => {
      const ref = referenceReadProcessLockPayload(c.contents);
      expect(ref !== null).toBe(c.accepted);

      const lockPath = writeLockFile(c.contents);
      const live = readProcessLockPayload(lockPath);
      expect(live).toEqual(ref);
    });
  }

  it('nonexistent lock file (read error) reads back as null', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'process-lock-zod-equiv-'));
    const missingPath = join(tmpRoot, 'does-not-exist.lock');
    expect(referenceReadProcessLockPayload('')).toBeNull(); // sanity: empty content also rejects
    expect(readProcessLockPayload(missingPath)).toBeNull();
  });
});

describe('bootId permissive-drop behavior (not part of the converted shape ladder)', () => {
  it('a wrong-typed bootId does not reject the payload, it is silently omitted', () => {
    const lockPath = writeLockFile(JSON.stringify({ pid: 1, token: 't', startedAt: 's', bootId: 12345 }));
    const result = readProcessLockPayload(lockPath);
    expect(result).not.toBeNull();
    expect(result).toEqual({ pid: 1, token: 't', startedAt: 's' });
    expect(Object.prototype.hasOwnProperty.call(result, 'bootId')).toBe(false);
  });

  it('a null bootId does not reject the payload, it is silently omitted', () => {
    const lockPath = writeLockFile(JSON.stringify({ pid: 1, token: 't', startedAt: 's', bootId: null }));
    const result = readProcessLockPayload(lockPath);
    expect(result).toEqual({ pid: 1, token: 't', startedAt: 's' });
  });

  it('a valid string bootId is preserved', () => {
    const lockPath = writeLockFile(JSON.stringify({ pid: 1, token: 't', startedAt: 's', bootId: 'boot-xyz' }));
    expect(readProcessLockPayload(lockPath)).toEqual({ pid: 1, token: 't', startedAt: 's', bootId: 'boot-xyz' });
  });
});
