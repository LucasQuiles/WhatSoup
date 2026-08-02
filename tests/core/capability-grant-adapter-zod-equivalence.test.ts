// tests/core/capability-grant-adapter-zod-equivalence.test.ts
//
// Equivalence net for #2203: the module-private `isGrantRecord` guard in
// `src/core/capability-grant-adapter.ts` moves from a hand-rolled typeof
// ladder to a Zod schema. The verbatim pre-conversion ladder is kept below
// as the reference implementation; every case asserts the reference verdict
// AND the observable verdict through the public seam, so the conversion
// cannot widen or narrow the accepted value space.
//
// The guard is file-private, so `createFileGrantStore(path).read()` is the
// observable surface — its input domain is exactly JSON.parse output (the
// guard only ever sees parsed rollback-state file contents), which is why
// every case is expressed as raw file text.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileGrantStore } from '../../src/core/capability-grant-adapter.ts';
import type { GrantRecord } from '../../src/lib/capability-grant.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize this — it defines the value space the Zod schema must
// reproduce exactly.
function referenceIsGrantRecord(v: unknown): v is GrantRecord {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  const capabilities = r.capabilities;
  const addedToAllow = r.addedToAllow;
  const removedFromDeny = r.removedFromDeny;
  if (
    !isStringArray(capabilities) ||
    !isStringArray(addedToAllow) ||
    !isStringArray(removedFromDeny)
  ) {
    return false;
  }
  return (
    r.version === 2 &&
    typeof r.group === 'string' && r.group.length > 0 &&
    Number.isSafeInteger(r.armedAtMs) && (r.armedAtMs as number) >= 0 &&
    (r.expiresAtMs === null ||
      (Number.isSafeInteger(r.expiresAtMs) && (r.expiresAtMs as number) > (r.armedAtMs as number))) &&
    addedToAllow.every((entry) => capabilities.includes(entry)) &&
    removedFromDeny.every((entry) => capabilities.includes(entry))
  );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cap-grant-zod-equiv-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRawStoreFile(json: string): string {
  const filePath = join(dir, 'grant.json');
  writeFileSync(filePath, json, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

interface Case {
  name: string;
  json: string;
  accepted: boolean;
}

const validBase = {
  version: 2,
  armedAtMs: 1000,
  expiresAtMs: 2000,
  group: 'camera',
  capabilities: ['camera.snap', 'camera.clip'],
  addedToAllow: ['camera.snap'],
  removedFromDeny: ['camera.clip'],
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UNSAFE_2_60 = 2 ** 60;

/** Returns a copy of `validBase` with `key` deleted, for "field missing" cases. */
function omit(key: keyof typeof validBase): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...validBase };
  delete copy[key];
  return copy;
}

const cases: Case[] = [
  // Accepted shapes.
  { name: 'canonical record', json: JSON.stringify(validBase), accepted: true },
  { name: 'expiresAtMs null (manual-only grant)', json: JSON.stringify({ ...validBase, expiresAtMs: null }), accepted: true },
  { name: 'empty capabilities/addedToAllow/removedFromDeny', json: JSON.stringify({ ...validBase, capabilities: [], addedToAllow: [], removedFromDeny: [] }), accepted: true },
  { name: 'armedAtMs = 0 (boundary nonnegative)', json: JSON.stringify({ ...validBase, armedAtMs: 0, expiresAtMs: 1 }), accepted: true },
  { name: 'armedAtMs = MAX_SAFE_INTEGER trap: acceptance case', json: JSON.stringify({ ...validBase, armedAtMs: MAX_SAFE, expiresAtMs: null }), accepted: true },
  { name: 'extra top-level key tolerated (passthrough semantics)', json: JSON.stringify({ ...validBase, extra: 'ignored' }), accepted: true },
  { name: 'group with whitespace (ladder only checks length > 0)', json: JSON.stringify({ ...validBase, group: '  ' }), accepted: true },
  { name: 'addedToAllow/removedFromDeny both empty while capabilities non-empty', json: JSON.stringify({ ...validBase, addedToAllow: [], removedFromDeny: [] }), accepted: true },
  // version rejections.
  { name: 'version wrong number (1)', json: JSON.stringify({ ...validBase, version: 1 }), accepted: false },
  { name: 'version as string "2"', json: JSON.stringify({ ...validBase, version: '2' }), accepted: false },
  { name: 'version missing', json: JSON.stringify(omit('version')), accepted: false },
  // group rejections.
  { name: 'group empty string', json: JSON.stringify({ ...validBase, group: '' }), accepted: false },
  { name: 'group wrong type (number)', json: JSON.stringify({ ...validBase, group: 42 }), accepted: false },
  { name: 'group missing', json: JSON.stringify(omit('group')), accepted: false },
  { name: 'group null', json: JSON.stringify({ ...validBase, group: null }), accepted: false },
  // armedAtMs rejections.
  { name: 'armedAtMs negative', json: JSON.stringify({ ...validBase, armedAtMs: -1 }), accepted: false },
  { name: 'armedAtMs non-integer', json: JSON.stringify({ ...validBase, armedAtMs: 1.5 }), accepted: false },
  { name: 'armedAtMs unsafe integer (2**60) trap: rejection case', json: JSON.stringify({ ...validBase, armedAtMs: UNSAFE_2_60, expiresAtMs: UNSAFE_2_60 + 1000 }), accepted: false },
  { name: 'armedAtMs wrong type (string)', json: JSON.stringify({ ...validBase, armedAtMs: '1000' }), accepted: false },
  { name: 'armedAtMs missing', json: JSON.stringify(omit('armedAtMs')), accepted: false },
  { name: 'armedAtMs null', json: JSON.stringify({ ...validBase, armedAtMs: null }), accepted: false },
  // expiresAtMs rejections.
  { name: 'expiresAtMs equal to armedAtMs (not strictly greater)', json: JSON.stringify({ ...validBase, armedAtMs: 1000, expiresAtMs: 1000 }), accepted: false },
  { name: 'expiresAtMs less than armedAtMs', json: JSON.stringify({ ...validBase, armedAtMs: 1000, expiresAtMs: 500 }), accepted: false },
  { name: 'expiresAtMs non-integer', json: JSON.stringify({ ...validBase, expiresAtMs: 1500.5 }), accepted: false },
  { name: 'expiresAtMs unsafe integer (2**60) trap: rejection case', json: JSON.stringify({ ...validBase, armedAtMs: 0, expiresAtMs: UNSAFE_2_60 }), accepted: false },
  { name: 'expiresAtMs wrong type (string)', json: JSON.stringify({ ...validBase, expiresAtMs: '2000' }), accepted: false },
  { name: 'expiresAtMs missing (undefined, not null)', json: JSON.stringify(omit('expiresAtMs')), accepted: false },
  // capabilities/addedToAllow/removedFromDeny type rejections.
  { name: 'capabilities missing', json: JSON.stringify(omit('capabilities')), accepted: false },
  { name: 'capabilities not an array (string)', json: JSON.stringify({ ...validBase, capabilities: 'camera.snap' }), accepted: false },
  { name: 'capabilities entry non-string', json: JSON.stringify({ ...validBase, capabilities: ['camera.snap', 7] }), accepted: false },
  { name: 'addedToAllow not an array', json: JSON.stringify({ ...validBase, addedToAllow: 'camera.snap' }), accepted: false },
  { name: 'addedToAllow entry non-string', json: JSON.stringify({ ...validBase, addedToAllow: [null] }), accepted: false },
  { name: 'removedFromDeny not an array', json: JSON.stringify({ ...validBase, removedFromDeny: {} }), accepted: false },
  { name: 'removedFromDeny entry non-string', json: JSON.stringify({ ...validBase, removedFromDeny: [123] }), accepted: false },
  // Cross-field membership rejections.
  { name: 'addedToAllow entry not present in capabilities', json: JSON.stringify({ ...validBase, addedToAllow: ['not.a.capability'] }), accepted: false },
  { name: 'removedFromDeny entry not present in capabilities', json: JSON.stringify({ ...validBase, removedFromDeny: ['not.a.capability'] }), accepted: false },
  // Top-level rejections.
  { name: 'top-level null', json: 'null', accepted: false },
  { name: 'top-level string', json: JSON.stringify('grant'), accepted: false },
  { name: 'top-level number', json: '42', accepted: false },
  { name: 'top-level boolean', json: 'true', accepted: false },
  { name: 'top-level empty array', json: '[]', accepted: false },
  { name: 'top-level array wrapping a valid record (array-root trap: rejected via a different path than field checks)', json: JSON.stringify([validBase]), accepted: false },
];

describe('isGrantRecord equivalence (observed through createFileGrantStore(...).read())', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, async () => {
      const parsed: unknown = JSON.parse(c.json);
      // The table must encode exactly what the pre-conversion ladder decided.
      expect(referenceIsGrantRecord(parsed)).toBe(c.accepted);

      const path = writeRawStoreFile(c.json);
      const store = createFileGrantStore(path);
      if (c.accepted) {
        const loaded = await store.read();
        expect(loaded).toEqual(parsed);
      } else {
        await expect(store.read()).rejects.toThrow('invalid capability grant store');
      }
    });
  }
});
