// tests/fleet/token-storage-zod-equivalence.test.ts
//
// Equivalence net for #2203: the module-private shape guards in
// `src/fleet/token-storage.ts` (`isValidToken` / `isFleetTokensFile`) move from
// hand-rolled typeof ladders to Zod schemas. The verbatim pre-conversion
// ladders are kept below as the reference implementation; every case asserts
// the reference verdict AND the observable verdict through the public loader,
// so the conversion cannot widen or narrow the accepted value space.
//
// The guards are file-private, so `loadOrCreateFleetTokens` is the observable
// surface. Its input domain is exactly JSON.parse output (the guards only ever
// see parsed fleet-tokens.json / legacy fleet-token file contents), which is
// why every case is expressed as raw file text.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadOrCreateFleetTokens,
  getFleetTokensPath,
  getLegacyFleetTokenPath,
  MAX_ACCEPT_ENTRIES,
} from '../../src/fleet/token-storage.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladders. ---
// Do not modernize these — they define the value space the Zod schemas must
// reproduce exactly.
const TOKEN_RE = /^[0-9a-f]{64}$/;

function referenceIsValidToken(value: unknown): boolean {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function referenceIsFleetTokensFile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (!referenceIsValidToken(rec.active)) return false;
  if (!Array.isArray(rec.accept)) return false;
  if (!rec.accept.every(referenceIsValidToken)) return false;
  if (typeof rec.rotatedAt !== 'string') return false;
  return true;
}

const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);
const T3 = 'c'.repeat(64);
const T4 = 'd'.repeat(64);
const T5 = 'e'.repeat(64);
const T6 = 'f'.repeat(64);

let tmpRoot: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-token-zod-equiv-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRawTokensFile(json: string): void {
  const filePath = getFleetTokensPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, json, { encoding: 'utf-8', mode: 0o600 });
}

interface FileCase {
  name: string;
  json: string;
  accepted: boolean;
}

const fileCases: FileCase[] = [
  // Accepted shapes.
  { name: 'canonical file, empty accept', json: JSON.stringify({ active: T1, accept: [], rotatedAt: '2026-01-01T00:00:00.000Z' }), accepted: true },
  { name: 'accept with entries', json: JSON.stringify({ active: T1, accept: [T2, T3], rotatedAt: '2026-01-01T00:00:00.000Z' }), accepted: true },
  { name: 'rotatedAt empty string (ladder only checks typeof)', json: JSON.stringify({ active: T1, accept: [], rotatedAt: '' }), accepted: true },
  { name: 'rotatedAt arbitrary non-ISO string', json: JSON.stringify({ active: T1, accept: [], rotatedAt: 'not a date' }), accepted: true },
  { name: 'extra top-level key tolerated (passthrough semantics)', json: JSON.stringify({ active: T1, accept: [], rotatedAt: '', extra: 123 }), accepted: true },
  { name: 'accept longer than cap still accepted (trimmed downstream)', json: JSON.stringify({ active: T1, accept: [T2, T3, T4, T5, T6], rotatedAt: '' }), accepted: true },
  // active field rejections.
  { name: 'active missing', json: JSON.stringify({ accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active null', json: JSON.stringify({ active: null, accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active empty string', json: JSON.stringify({ active: '', accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active wrong type (number)', json: JSON.stringify({ active: 123, accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active 63-hex (too short)', json: JSON.stringify({ active: 'a'.repeat(63), accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active 65-hex (too long)', json: JSON.stringify({ active: 'a'.repeat(65), accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active uppercase hex', json: JSON.stringify({ active: 'A'.repeat(64), accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active non-hex characters', json: JSON.stringify({ active: 'g'.repeat(64), accept: [], rotatedAt: '' }), accepted: false },
  { name: 'active array of characters', json: JSON.stringify({ active: T1.split(''), accept: [], rotatedAt: '' }), accepted: false },
  // accept field rejections.
  { name: 'accept missing', json: JSON.stringify({ active: T1, rotatedAt: '' }), accepted: false },
  { name: 'accept null', json: JSON.stringify({ active: T1, accept: null, rotatedAt: '' }), accepted: false },
  { name: 'accept string instead of array', json: JSON.stringify({ active: T1, accept: T2, rotatedAt: '' }), accepted: false },
  { name: 'accept object instead of array', json: JSON.stringify({ active: T1, accept: { 0: T2 }, rotatedAt: '' }), accepted: false },
  { name: 'accept entry malformed', json: JSON.stringify({ active: T1, accept: [T2, 'bad'], rotatedAt: '' }), accepted: false },
  { name: 'accept entry empty string', json: JSON.stringify({ active: T1, accept: [''], rotatedAt: '' }), accepted: false },
  { name: 'accept entry null', json: JSON.stringify({ active: T1, accept: [T2, null], rotatedAt: '' }), accepted: false },
  { name: 'accept entry number', json: JSON.stringify({ active: T1, accept: [7], rotatedAt: '' }), accepted: false },
  // rotatedAt field rejections.
  { name: 'rotatedAt missing', json: JSON.stringify({ active: T1, accept: [] }), accepted: false },
  { name: 'rotatedAt null', json: JSON.stringify({ active: T1, accept: [], rotatedAt: null }), accepted: false },
  { name: 'rotatedAt wrong type (number)', json: JSON.stringify({ active: T1, accept: [], rotatedAt: 123 }), accepted: false },
  // Top-level rejections.
  { name: 'top-level null', json: 'null', accepted: false },
  { name: 'top-level string', json: JSON.stringify(T1), accepted: false },
  { name: 'top-level number', json: '42', accepted: false },
  { name: 'top-level boolean', json: 'true', accepted: false },
  { name: 'top-level empty array', json: '[]', accepted: false },
  { name: 'top-level array wrapping a valid record', json: JSON.stringify([{ active: T1, accept: [], rotatedAt: '' }]), accepted: false },
];

describe('isFleetTokensFile equivalence (observed through loadOrCreateFleetTokens)', () => {
  for (const c of fileCases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, () => {
      const parsed: unknown = JSON.parse(c.json);
      // The table must encode exactly what the pre-conversion ladder decided.
      expect(referenceIsFleetTokensFile(parsed)).toBe(c.accepted);

      writeRawTokensFile(c.json);
      if (c.accepted) {
        const rec = parsed as { active: string; accept: string[]; rotatedAt: string };
        const loaded = loadOrCreateFleetTokens();
        expect(loaded.active).toBe(rec.active);
        expect(loaded.accept).toEqual(rec.accept.slice(0, MAX_ACCEPT_ENTRIES));
        expect(loaded.rotatedAt).toBe(rec.rotatedAt);
      } else {
        expect(() => loadOrCreateFleetTokens()).toThrow(/invalid shape/);
      }
    });
  }
});

interface LegacyCase {
  name: string;
  contents: string;
  valid: boolean;
}

const legacyCases: LegacyCase[] = [
  { name: 'canonical 64-hex', contents: T1, valid: true },
  { name: 'canonical with trailing newline (trimmed before guard)', contents: `${T2}\n`, valid: true },
  { name: 'canonical with surrounding spaces (trimmed before guard)', contents: `  ${T3}  `, valid: true },
  { name: 'empty file', contents: '', valid: false },
  { name: 'uppercase hex', contents: 'A'.repeat(64), valid: false },
  { name: '63-hex', contents: 'a'.repeat(63), valid: false },
  { name: '65-hex', contents: 'a'.repeat(65), valid: false },
  { name: 'non-hex text', contents: 'not-a-token', valid: false },
];

describe('isValidToken equivalence (observed through legacy migration)', () => {
  for (const c of legacyCases) {
    it(`${c.name} → ${c.valid ? 'migrated' : 'ignored'}`, () => {
      const trimmed = c.contents.trim();
      expect(referenceIsValidToken(trimmed)).toBe(c.valid);

      const legacyPath = getLegacyFleetTokenPath();
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(legacyPath, c.contents, { encoding: 'utf-8', mode: 0o600 });

      const loaded = loadOrCreateFleetTokens();
      if (c.valid) {
        expect(loaded.active).toBe(trimmed);
      } else {
        // Invalid legacy value is treated as absent: a fresh token is generated.
        expect(loaded.active).toMatch(TOKEN_RE);
        expect(loaded.active).not.toBe(trimmed);
      }
    });
  }
});
