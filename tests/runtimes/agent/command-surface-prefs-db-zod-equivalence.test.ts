// tests/runtimes/agent/command-surface-prefs-db-zod-equivalence.test.ts
//
// Equivalence net for Refs #2203 (tranche 3, Tier A): the module-private
// shape guard `validateSurfacePrefsShape` in
// `src/runtimes/agent/command-surface-prefs-db.ts` moves from a hand-rolled
// typeof ladder to a Zod schema. The verbatim pre-conversion ladder is kept
// below as the reference implementation; every case asserts the reference
// verdict AND the observable verdict through the public seam
// (`getSurfacePrefs`, which round-trips a raw `prefs_json` TEXT column
// through JSON.parse), so the conversion cannot widen or narrow the accepted
// value space.
//
// One documented behavior delta is NOT pinned here (unlike the #2857
// settings-template precedent, which pinned its analogous Date/Map
// divergence by calling its EXPORTED guard directly): z.object() rejects a
// top-level value whose `typeof` is `'object'` but is not a plain object
// (e.g. a Date or Map), where the previous ladder's `typeof value !==
// 'object'` check accepted such host objects. `validateSurfacePrefsShape` is
// module-private, and its only observable seam (`getSurfacePrefs`) reads a
// SQLite TEXT column through JSON.parse — a Date or Map can never be
// JSON.parse output, so the divergence is unreachable through the public
// seam and is documented in the source comment instead.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureCommandSurfacePrefsSchema,
  setSurfacePrefs,
  getSurfacePrefs,
  type UserSurfacePrefs,
} from '../../../src/runtimes/agent/command-surface-prefs-db.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize this — it defines the value space the Zod schema must
// reproduce exactly.
const VERBOSITIES: ReadonlySet<string> = new Set(['terse', 'normal']);

function referenceValidateSurfacePrefsShape(value: unknown): UserSurfacePrefs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  let hidden: readonly string[] | undefined;
  if (v['hidden'] !== undefined) {
    if (!Array.isArray(v['hidden']) || !(v['hidden'] as unknown[]).every((x) => typeof x === 'string')) {
      return null;
    }
    hidden = v['hidden'] as readonly string[];
  }

  let verbosity: 'terse' | 'normal' | undefined;
  if (v['verbosity'] !== undefined) {
    if (typeof v['verbosity'] !== 'string' || !VERBOSITIES.has(v['verbosity'])) return null;
    verbosity = v['verbosity'] as 'terse' | 'normal';
  }

  let locale: string | undefined;
  if (v['locale'] !== undefined) {
    if (typeof v['locale'] !== 'string') return null;
    locale = v['locale'];
  }

  let optionDefaults: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  if (v['optionDefaults'] !== undefined) {
    const od = v['optionDefaults'];
    if (typeof od !== 'object' || od === null || Array.isArray(od)) return null;
    for (const cmdOpts of Object.values(od as Record<string, unknown>)) {
      if (typeof cmdOpts !== 'object' || cmdOpts === null || Array.isArray(cmdOpts)) return null;
      for (const optValue of Object.values(cmdOpts as Record<string, unknown>)) {
        if (typeof optValue !== 'string') return null;
      }
    }
    optionDefaults = od as Readonly<Record<string, Readonly<Record<string, string>>>>;
  }

  return {
    ...(hidden !== undefined ? { hidden } : {}),
    ...(verbosity !== undefined ? { verbosity } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(optionDefaults !== undefined ? { optionDefaults } : {}),
  };
}

const CHAT_A = '111222333@g.us';
const SENDER_A = '15550000001@s.whatsapp.net';
const NOW = 1_500;

function tmpDbPath(): string {
  return join(tmpdir(), `command-surface-prefs-zod-equiv-${randomBytes(6).toString('hex')}.db`);
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = path + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
}

let dbPath: string;
let db: Database;

beforeEach(() => {
  dbPath = tmpDbPath();
  db = new Database(dbPath);
  ensureCommandSurfacePrefsSchema(db);
  // Seed a row so the UPDATE below has a target; the seeded value is
  // irrelevant, it is immediately overwritten with the raw case JSON.
  setSurfacePrefs(db, CHAT_A, SENDER_A, {}, NOW);
});

afterEach(() => {
  db.close();
  cleanupDbFile(dbPath);
});

function writeRawPrefsJson(json: string): void {
  db.raw
    .prepare(`UPDATE command_surface_prefs SET prefs_json = ? WHERE chat_jid = ? AND sender_jid = ?`)
    .run(json, CHAT_A, SENDER_A);
}

interface Case {
  name: string;
  json: string;
  accepted: boolean;
}

const cases: Case[] = [
  // Accepted shapes.
  { name: 'empty object', json: '{}', accepted: true },
  { name: 'hidden only', json: JSON.stringify({ hidden: ['status', 'typing'] }), accepted: true },
  { name: 'hidden empty array', json: JSON.stringify({ hidden: [] }), accepted: true },
  { name: 'verbosity terse', json: JSON.stringify({ verbosity: 'terse' }), accepted: true },
  { name: 'verbosity normal', json: JSON.stringify({ verbosity: 'normal' }), accepted: true },
  { name: 'locale only', json: JSON.stringify({ locale: 'en-US' }), accepted: true },
  { name: 'locale empty string (ladder only checks typeof)', json: JSON.stringify({ locale: '' }), accepted: true },
  { name: 'optionDefaults nested valid', json: JSON.stringify({ optionDefaults: { model: { provider: 'claude-cli' } } }), accepted: true },
  { name: 'optionDefaults empty object', json: JSON.stringify({ optionDefaults: {} }), accepted: true },
  { name: 'optionDefaults cmd with empty options object', json: JSON.stringify({ optionDefaults: { model: {} } }), accepted: true },
  { name: 'all fields combined', json: JSON.stringify({ hidden: ['status'], verbosity: 'terse', locale: 'en-US', optionDefaults: { model: { provider: 'x' } } }), accepted: true },
  { name: 'extra unknown top-level key tolerated (ignored, forward-compatible)', json: JSON.stringify({ locale: 'en', extra: 123 }), accepted: true },
  // Top-level rejections.
  { name: 'top-level null', json: 'null', accepted: false },
  { name: 'top-level array', json: '[]', accepted: false },
  { name: 'top-level string', json: JSON.stringify('hello'), accepted: false },
  { name: 'top-level number', json: '42', accepted: false },
  { name: 'top-level boolean', json: 'true', accepted: false },
  // hidden rejections.
  { name: 'hidden non-array (string)', json: JSON.stringify({ hidden: 'status' }), accepted: false },
  { name: 'hidden array with non-string entry', json: JSON.stringify({ hidden: ['status', 42] }), accepted: false },
  { name: 'hidden null', json: JSON.stringify({ hidden: null }), accepted: false },
  // verbosity rejections.
  { name: 'verbosity out-of-contract string', json: JSON.stringify({ verbosity: 'loud' }), accepted: false },
  { name: 'verbosity wrong type (number)', json: JSON.stringify({ verbosity: 5 }), accepted: false },
  { name: 'verbosity null', json: JSON.stringify({ verbosity: null }), accepted: false },
  // locale rejections.
  { name: 'locale wrong type (number)', json: JSON.stringify({ locale: 42 }), accepted: false },
  { name: 'locale null', json: JSON.stringify({ locale: null }), accepted: false },
  // optionDefaults rejections.
  { name: 'optionDefaults non-object (string)', json: JSON.stringify({ optionDefaults: 'x' }), accepted: false },
  { name: 'optionDefaults array', json: JSON.stringify({ optionDefaults: [] }), accepted: false },
  { name: 'optionDefaults null', json: JSON.stringify({ optionDefaults: null }), accepted: false },
  { name: 'optionDefaults cmd value is array', json: JSON.stringify({ optionDefaults: { model: ['a', 'b'] } }), accepted: false },
  { name: 'optionDefaults cmd value is null', json: JSON.stringify({ optionDefaults: { model: null } }), accepted: false },
  { name: 'optionDefaults inner option value not a string (number)', json: JSON.stringify({ optionDefaults: { model: { provider: 42 } } }), accepted: false },
  { name: 'optionDefaults inner option value not a string (null)', json: JSON.stringify({ optionDefaults: { model: { provider: null } } }), accepted: false },
  { name: 'optionDefaults inner option value not a string (object)', json: JSON.stringify({ optionDefaults: { model: { provider: {} } } }), accepted: false },
];

describe('validateSurfacePrefsShape equivalence (observed through getSurfacePrefs)', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, () => {
      const parsed: unknown = JSON.parse(c.json);
      // The table must encode exactly what the pre-conversion ladder decided.
      const ref = referenceValidateSurfacePrefsShape(parsed);
      expect(ref !== null).toBe(c.accepted);

      writeRawPrefsJson(c.json);
      if (c.accepted) {
        // Compare against the reference's actual output (unknown keys
        // stripped), not the raw parsed input.
        expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toEqual(ref);
      } else {
        expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
      }
    });
  }

  it('binary garbage (not valid UTF-8 JSON) reads back as null', () => {
    db.raw
      .prepare(`UPDATE command_surface_prefs SET prefs_json = x'DEADBEEF' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });
});
