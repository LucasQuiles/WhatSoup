// src/fleet/token-storage.ts
//
// Rotatable fleet-token storage.
//
// Storage layout (single file under XDG_CONFIG_HOME):
//
//   ~/.config/whatsoup/fleet-tokens.json
//     {
//       "active":    "<64-hex>",   // signs new WS tickets, used in API/Bearer
//       "accept":    ["<64-hex>", ...],  // historic tokens still accepted, max 4
//       "rotatedAt": "<ISO8601>"
//     }
//
// Migration: if a legacy single-string `fleet-token` file exists and no JSON
// file does, the legacy value is hoisted to `active`. The legacy file is left
// in place for one rollback cycle (operators can revert by removing the JSON
// file). Callers must never write back to the legacy path.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { xdgDir } from './paths.ts';
import { safeStringEqual } from './safe-compare.ts';
import { privateWriteError } from '../lib/private-fs.ts';

/** Maximum number of rotated-out tokens that remain valid. */
export const MAX_ACCEPT_ENTRIES = 4;

/** Wire shape of the persisted tokens file. */
export interface FleetTokensFile {
  active: string;
  accept: string[];
  rotatedAt: string;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

function tokenPaths(): { dir: string; legacy: string; current: string } {
  const dir = path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'whatsoup');
  return {
    dir,
    legacy: path.join(dir, 'fleet-token'),
    current: path.join(dir, 'fleet-tokens.json'),
  };
}

const FleetTokenSchema = z.string().regex(TOKEN_RE);

// `.passthrough()` because the previous guard only checked the listed keys —
// files carrying unknown extra keys stay accepted, not stripped or rejected.
// `satisfies` pins the schema output to the exported wire type at compile time.
const FleetTokensFileSchema = z.object({
  active: FleetTokenSchema,
  accept: z.array(FleetTokenSchema),
  rotatedAt: z.string(),
}).passthrough() satisfies z.ZodType<FleetTokensFile>;

function isValidToken(value: unknown): value is string {
  return FleetTokenSchema.safeParse(value).success;
}

function isFleetTokensFile(value: unknown): value is FleetTokensFile {
  return FleetTokensFileSchema.safeParse(value).success;
}

function assertPrivateTokenDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw privateWriteError('refusing to use fleet token directory through symlink', 'ELOOP');
  }
  if (!stat.isDirectory()) {
    throw privateWriteError('refusing to use fleet token directory over non-directory path', 'EINVAL');
  }
}

function assertReadableTokenFile(filePath: string, label: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError(`refusing to read ${label} through symlink`, 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError(`refusing to read ${label} from non-regular path`, 'EINVAL');
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function assertWritableTokenFile(filePath: string): void {
  if (!assertReadableTokenFile(filePath, 'fleet-tokens.json')) return;
}

/** Generate a fresh 32-byte (64-hex) token. */
export function generateFleetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Verify that `candidate` is one of the accepted fleet tokens.
 *
 * Constant-time per candidate; iterates over [active, ...accept] without
 * short-circuiting so total work stays flat across the accept list. Storage
 * invariants (canonical hex shape) are enforced at load time; this
 * comparison is shape-agnostic so the server can run with operator-supplied
 * tokens from deployment scripts that predate the canonical generator.
 */
export function verifyFleetToken(candidate: string, tokens: { active: string; accept: readonly string[] }): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const all = [tokens.active, ...tokens.accept];
  let matched = false;
  for (const known of all) {
    // `safeStringEqual` is shape-agnostic and never throws — malformed
    // multibyte candidates (see #405) return false instead of bubbling a
    // RangeError up to the HTTP layer. The loop still visits every entry so
    // total work stays flat across accept[] regardless of which slot hits.
    if (safeStringEqual(candidate, known)) {
      matched = true;
    }
  }
  return matched;
}

function readTokensFile(currentPath: string): FleetTokensFile | null {
  if (!assertReadableTokenFile(currentPath, 'fleet-tokens.json')) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(currentPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`fleet-tokens.json at ${currentPath} is not valid JSON — refusing to auto-fix`);
  }
  if (!isFleetTokensFile(parsed)) {
    throw new Error(`fleet-tokens.json at ${currentPath} has invalid shape — refusing to auto-fix`);
  }
  // Trim accept to the documented cap to defend against hand-edited files.
  return {
    active: parsed.active,
    accept: parsed.accept.slice(0, MAX_ACCEPT_ENTRIES),
    rotatedAt: parsed.rotatedAt,
  };
}

function readLegacyToken(legacyPath: string): string | null {
  if (!assertReadableTokenFile(legacyPath, 'legacy fleet-token')) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(legacyPath, 'utf-8').trim();
  } catch {
    return null;
  }
  return isValidToken(raw) ? raw : null;
}

function writeTokensFile(currentPath: string, tokens: FleetTokensFile): void {
  const dir = path.dirname(currentPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateTokenDirectory(dir);
  fs.chmodSync(dir, 0o700);
  assertWritableTokenFile(currentPath);

  const tmpPath = `${currentPath}.tmp-${process.pid}-${Date.now()}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(tokens, null, 2)}\n`, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    assertWritableTokenFile(currentPath);
    fs.renameSync(tmpPath, currentPath);
    fs.chmodSync(currentPath, 0o600);

    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Some filesystems reject directory fsync; the file was still fsynced
      // before the atomic rename.
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Load existing tokens, migrate from legacy if needed, or initialize new.
 *
 * Behavior matrix:
 *  - fleet-tokens.json exists and parses → return it
 *  - fleet-tokens.json missing, legacy fleet-token present → hoist as active,
 *    write JSON, leave legacy untouched
 *  - fleet-tokens.json missing, legacy absent → generate new active, write JSON
 *  - fleet-tokens.json present but malformed → throw (refuse silent recovery)
 */
export function loadOrCreateFleetTokens(): FleetTokensFile {
  const { current, legacy } = tokenPaths();

  const existing = readTokensFile(current);
  if (existing) return existing;

  const legacyValue = readLegacyToken(legacy);
  if (legacyValue) {
    const migrated: FleetTokensFile = {
      active: legacyValue,
      accept: [],
      rotatedAt: new Date(0).toISOString(),
    };
    writeTokensFile(current, migrated);
    return migrated;
  }

  const created: FleetTokensFile = {
    active: generateFleetToken(),
    accept: [],
    rotatedAt: new Date().toISOString(),
  };
  writeTokensFile(current, created);
  return created;
}

/**
 * Rotate the active token. Moves the prior `active` to the head of `accept[]`
 * and trims the array to MAX_ACCEPT_ENTRIES. Returns the post-rotation file.
 */
export function rotateFleetTokens(prior: FleetTokensFile): FleetTokensFile {
  const newActive = generateFleetToken();
  const accept = [prior.active, ...prior.accept].slice(0, MAX_ACCEPT_ENTRIES);
  return {
    active: newActive,
    accept,
    rotatedAt: new Date().toISOString(),
  };
}

/** Test/CLI helpers. Exposed so scripts can avoid hard-coding the path. */
export function getFleetTokensPath(): string {
  return tokenPaths().current;
}

export function getLegacyFleetTokenPath(): string {
  return tokenPaths().legacy;
}

/** Persist `tokens` to disk. Used by the rotation CLI; createServer never writes. */
export function saveFleetTokens(tokens: FleetTokensFile): void {
  writeTokensFile(tokenPaths().current, tokens);
}
