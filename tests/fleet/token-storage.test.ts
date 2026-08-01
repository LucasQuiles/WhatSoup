// tests/fleet/token-storage.test.ts
//
// Cover the rotatable fleet-token storage in `src/fleet/token-storage.ts`:
//  - generates a fresh tokens file when none exists
//  - migrates a legacy single-string `fleet-token` into `{active, accept, rotatedAt}`
//  - leaves the legacy file in place (rollback window)
//  - rotation: active → accept[0], cap at MAX_ACCEPT_ENTRIES, fresh active
//  - verifyFleetToken accepts active + any accept entry, rejects unknown/malformed
//  - refuses corrupt JSON / wrong-shape files instead of silently rewriting

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadOrCreateFleetTokens,
  rotateFleetTokens,
  saveFleetTokens,
  verifyFleetToken,
  generateFleetToken,
  getFleetTokensPath,
  getLegacyFleetTokenPath,
  MAX_ACCEPT_ENTRIES,
  type FleetTokensFile,
} from '../../src/fleet/token-storage.ts';

let tmpRoot: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-token-storage-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadOrCreateFleetTokens — fresh install', () => {
  it('generates a tokens file with active+empty accept when nothing exists', () => {
    const tokens = loadOrCreateFleetTokens();
    expect(tokens.active).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.accept).toEqual([]);
    expect(typeof tokens.rotatedAt).toBe('string');

    // File written at the canonical path
    const filePath = getFleetTokensPath();
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FleetTokensFile;
    expect(onDisk.active).toBe(tokens.active);
  });

  it('persists the token file with private file and directory modes', () => {
    loadOrCreateFleetTokens();
    const filePath = getFleetTokensPath();
    const dirPath = path.dirname(filePath);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirPath).mode & 0o777).toBe(0o700);
  });

  it('removes temporary token files when atomic publish fails on the real filesystem', () => {
    const filePath = getFleetTokensPath();
    const dirPath = path.dirname(filePath);
    fs.mkdirSync(filePath, { recursive: true });

    expect(() => loadOrCreateFleetTokens()).toThrow();

    const leftovers = fs.existsSync(dirPath)
      ? fs.readdirSync(dirPath).filter((name) => name.includes('fleet-tokens.json.tmp-'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('refuses to write a token file through a pre-existing temp symlink', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12_345);
    const filePath = getFleetTokensPath();
    const tmpPath = `${filePath}.tmp-${process.pid}-12345`;
    const outside = path.join(tmpRoot, 'outside-token-target');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(outside, 'outside-original', { mode: 0o600 });
    fs.symlinkSync(outside, tmpPath);

    expect(() => loadOrCreateFleetTokens()).toThrow();
    expect(fs.readFileSync(outside, 'utf-8')).toBe('outside-original');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('refuses to use a token directory through a symlink', () => {
    const dirPath = path.dirname(getFleetTokensPath());
    const targetDir = path.join(tmpRoot, 'outside-token-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(targetDir, dirPath);

    expect(() => loadOrCreateFleetTokens()).toThrow(/directory through symlink/);
  });

  it('returns the same active token on subsequent calls', () => {
    const first = loadOrCreateFleetTokens();
    const second = loadOrCreateFleetTokens();
    expect(second.active).toBe(first.active);
    expect(second.accept).toEqual(first.accept);
  });
});

describe('loadOrCreateFleetTokens — legacy migration', () => {
  it('hoists a valid legacy single-string token to active and leaves legacy on disk', () => {
    const legacyPath = getLegacyFleetTokenPath();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacyToken = 'a'.repeat(64);
    fs.writeFileSync(legacyPath, `${legacyToken}\n`);

    const tokens = loadOrCreateFleetTokens();
    expect(tokens.active).toBe(legacyToken);
    expect(tokens.accept).toEqual([]);

    // Legacy file preserved (one rollback cycle)
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.readFileSync(legacyPath, 'utf-8').trim()).toBe(legacyToken);

    // New JSON file persisted
    expect(fs.existsSync(getFleetTokensPath())).toBe(true);
  });

  it('does not consult legacy when fleet-tokens.json already exists', () => {
    // Pre-seed JSON
    const jsonPath = getFleetTokensPath();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    const seeded: FleetTokensFile = {
      active: 'b'.repeat(64),
      accept: [],
      rotatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(jsonPath, JSON.stringify(seeded));

    // Also write a legacy file with a different value
    fs.writeFileSync(getLegacyFleetTokenPath(), 'c'.repeat(64));

    const tokens = loadOrCreateFleetTokens();
    expect(tokens.active).toBe('b'.repeat(64));
  });

  it('ignores an invalid legacy token and creates a fresh active token', () => {
    const legacyPath = getLegacyFleetTokenPath();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, 'not-a-valid-token');

    const tokens = loadOrCreateFleetTokens();

    expect(tokens.active).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.active).not.toBe('not-a-valid-token');
    expect(tokens.accept).toEqual([]);
  });
});

describe('loadOrCreateFleetTokens — corrupt file', () => {
  it('throws on non-JSON content rather than overwriting', () => {
    const jsonPath = getFleetTokensPath();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, 'not-json-at-all');
    expect(() => loadOrCreateFleetTokens()).toThrow(/refusing to auto-fix/);
  });

  it('throws on wrong-shape JSON rather than overwriting', () => {
    const jsonPath = getFleetTokensPath();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({ active: 'short', accept: [] }));
    expect(() => loadOrCreateFleetTokens()).toThrow(/invalid shape/);
  });

  it.each([
    ['null JSON', null],
    ['array JSON', []],
    ['string JSON', 'not-an-object'],
    ['non-array accept', { active: 'f'.repeat(64), accept: 'not-array', rotatedAt: new Date().toISOString() }],
    ['invalid accept token', { active: 'f'.repeat(64), accept: ['short'], rotatedAt: new Date().toISOString() }],
    ['non-string rotatedAt', { active: 'f'.repeat(64), accept: [], rotatedAt: 123 }],
  ])('throws on %s rather than overwriting', (_label, payload) => {
    const jsonPath = getFleetTokensPath();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(payload));

    expect(() => loadOrCreateFleetTokens()).toThrow(/invalid shape/);
  });

  it('treats an unreadable current JSON file as absent and rewrites it', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const jsonPath = getFleetTokensPath();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({
      active: 'a'.repeat(64),
      accept: [],
      rotatedAt: new Date().toISOString(),
    }));
    fs.chmodSync(jsonPath, 0o000);

    const tokens = loadOrCreateFleetTokens();

    expect(tokens.active).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.active).not.toBe('a'.repeat(64));
    expect(fs.statSync(jsonPath).mode & 0o777).toBe(0o600);
  });

  it('treats an unreadable legacy token as absent during migration', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const legacyPath = getLegacyFleetTokenPath();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, `${'a'.repeat(64)}\n`);
    fs.chmodSync(legacyPath, 0o000);

    const tokens = loadOrCreateFleetTokens();

    expect(tokens.active).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.active).not.toBe('a'.repeat(64));
    fs.chmodSync(legacyPath, 0o600);
  });

  it('refuses to read fleet-tokens.json through a symlink', () => {
    const jsonPath = getFleetTokensPath();
    const outside = path.join(tmpRoot, 'outside-fleet-tokens.json');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(outside, JSON.stringify({
      active: 'd'.repeat(64),
      accept: [],
      rotatedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    fs.symlinkSync(outside, jsonPath);

    expect(() => loadOrCreateFleetTokens()).toThrow(/symlink/);
  });

  it('refuses to read legacy fleet-token through a symlink during migration', () => {
    const legacyPath = getLegacyFleetTokenPath();
    const outside = path.join(tmpRoot, 'outside-legacy-token');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(outside, `${'e'.repeat(64)}\n`, { mode: 0o600 });
    fs.symlinkSync(outside, legacyPath);

    expect(() => loadOrCreateFleetTokens()).toThrow(/symlink/);
    expect(fs.readFileSync(outside, 'utf-8')).toBe(`${'e'.repeat(64)}\n`);
  });
});

describe('rotateFleetTokens', () => {
  it('rotates active into accept[0] and generates a new active', () => {
    const initial = loadOrCreateFleetTokens();
    const rotated = rotateFleetTokens(initial);

    expect(rotated.active).not.toBe(initial.active);
    expect(rotated.active).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.accept[0]).toBe(initial.active);
  });

  it('caps accept[] at MAX_ACCEPT_ENTRIES across many rotations', () => {
    let tokens = loadOrCreateFleetTokens();
    for (let i = 0; i < MAX_ACCEPT_ENTRIES + 3; i++) {
      tokens = rotateFleetTokens(tokens);
    }
    expect(tokens.accept).toHaveLength(MAX_ACCEPT_ENTRIES);
    expect(tokens.accept[0]).not.toBe(tokens.active);
  });

  it('round-trips through saveFleetTokens + loadOrCreateFleetTokens', () => {
    const initial = loadOrCreateFleetTokens();
    const rotated = rotateFleetTokens(initial);
    saveFleetTokens(rotated);
    const reloaded = loadOrCreateFleetTokens();
    expect(reloaded.active).toBe(rotated.active);
    expect(reloaded.accept).toEqual(rotated.accept);
  });
});

describe('verifyFleetToken', () => {
  it('accepts the active token', () => {
    const tokens = loadOrCreateFleetTokens();
    expect(verifyFleetToken(tokens.active, tokens)).toBe(true);
  });

  it('accepts any token in accept[]', () => {
    let tokens = loadOrCreateFleetTokens();
    const original = tokens.active;
    tokens = rotateFleetTokens(tokens);
    expect(verifyFleetToken(original, tokens)).toBe(true);
    expect(verifyFleetToken(tokens.active, tokens)).toBe(true);
  });

  it('rejects unknown tokens', () => {
    const tokens = loadOrCreateFleetTokens();
    const unknown = generateFleetToken();
    expect(verifyFleetToken(unknown, tokens)).toBe(false);
  });

  it('rejects malformed input (wrong length / non-hex)', () => {
    const tokens = loadOrCreateFleetTokens();
    expect(verifyFleetToken('', tokens)).toBe(false);
    expect(verifyFleetToken('not-hex', tokens)).toBe(false);
    expect(verifyFleetToken('z'.repeat(64), tokens)).toBe(false);
    expect(verifyFleetToken(tokens.active.slice(0, 63), tokens)).toBe(false);
  });

  it('rejects multibyte candidates without throwing (regression: #405)', () => {
    // Pre-fix: `verifyFleetToken` gated on `.length`, then called
    // `timingSafeEqual` on UTF-8 Buffers. A candidate of 64 multibyte chars
    // had Buffer.byteLength > 64, mismatching the known token's byteLength
    // and throwing RangeError up the stack. Caller then surfaced 500 instead
    // of 401. Comparison MUST return false silently.
    const tokens = loadOrCreateFleetTokens();
    expect(() => verifyFleetToken('é'.repeat(64), tokens)).not.toThrow();
    expect(verifyFleetToken('é'.repeat(64), tokens)).toBe(false);
    // Lone surrogate also must not throw.
    expect(() => verifyFleetToken('\uD800'.repeat(64), tokens)).not.toThrow();
    expect(verifyFleetToken('\uD800'.repeat(64), tokens)).toBe(false);
  });

  it('rejects rotated-out tokens once they fall off accept[]', () => {
    let tokens = loadOrCreateFleetTokens();
    const oldest = tokens.active;
    // Force enough rotations to push `oldest` out of accept[]
    for (let i = 0; i < MAX_ACCEPT_ENTRIES + 1; i++) {
      tokens = rotateFleetTokens(tokens);
    }
    expect(verifyFleetToken(oldest, tokens)).toBe(false);
  });
});
