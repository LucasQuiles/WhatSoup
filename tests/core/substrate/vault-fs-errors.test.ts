/**
 * #2359 finding 3 — Obsidian vault projections must not leak a raw errno.
 *
 * `projectBead` / `projectEntity` wrote their markdown with an unguarded
 * `writeFileSync`, so a full or read-only vault volume threw straight up
 * through whatever ingest or regeneration path triggered the projection. The
 * issue also notes the inconsistency: `unlinkSync` in the same module WAS
 * already guarded. These tests pin the fix and the asymmetry that is correct.
 *
 * Setup mirrors tests/core/substrate/vault.test.ts (real Database, real
 * substrate helpers to seed) so only the filesystem layer is simulated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: fsMock.writeFileSync, unlinkSync: fsMock.unlinkSync };
});

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({ createChildLogger: () => logMock }));

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// NOTE: cleanup deliberately uses rmSync, which this file does NOT mock.
// Importing `unlinkSync` here would bind to the mock, so the afterEach would
// throw whatever errno a test had just installed.
import { existsSync, rmSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { upsertEntity } from '../../../src/core/substrate/entities.ts';
import {
  projectBead, projectEntity, removeEntityProjection,
} from '../../../src/core/substrate/vault.ts';

/** Build an errno the way Node does, so `.code` is a real property. */
function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function tmpDir() { return join(tmpdir(), `vault-fs-${randomBytes(8).toString('hex')}`); }
function tmpFile() { return join(tmpdir(), `sub-fs-${randomBytes(8).toString('hex')}.db`); }

describe('vault projection filesystem error handling (#2359)', () => {
  let dbPath: string; let vaultPath: string; let db: Database;

  beforeEach(() => {
    fsMock.writeFileSync.mockReset();
    fsMock.unlinkSync.mockReset();
    logMock.error.mockReset();
    dbPath = tmpFile(); vaultPath = tmpDir();
    db = new Database(dbPath); db.open();
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    if (existsSync(vaultPath)) rmSync(vaultPath, { recursive: true, force: true });
  });

  function seedBead(): number {
    return createBead(db.raw, {
      kind: 'task', title: 'a bead', ownerJid: 'mw',
      chatJid: 'user-1@s.whatsapp.net', sourceMessagePk: 1, actor: 'inline',
    }).id;
  }

  function seedEntity(): number {
    return upsertEntity(db.raw, { kind: 'person', canonicalName: 'Someone' }).id;
  }

  it('converts an ENOSPC bead projection into a structured error naming the projection', () => {
    const id = seedBead();
    fsMock.writeFileSync.mockImplementation(() => { throw errno('ENOSPC'); });

    let caught: NodeJS.ErrnoException | undefined;
    try { projectBead(db.raw, { vaultPath, beadId: id }); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/vault projection unavailable/i);
    expect(caught?.message).toMatch(/bead projection/i);
    // The original errno is PRESERVED, not flattened — a caller can still tell
    // "disk full" from "permission denied".
    expect(caught?.code).toBe('ENOSPC');
    expect(caught?.path).toMatch(/\.md$/);
  });

  it('does the same for an entity projection, tagged as entity not bead', () => {
    const id = seedEntity();
    fsMock.writeFileSync.mockImplementation(() => { throw errno('EACCES'); });

    let caught: NodeJS.ErrnoException | undefined;
    try { projectEntity(db.raw, { vaultPath, entityId: id }); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EACCES');
    expect(caught?.message).toMatch(/entity projection/i);
  });

  it('logs the failure with code, path and projection kind rather than swallowing it', () => {
    const id = seedBead();
    fsMock.writeFileSync.mockImplementation(() => { throw errno('EROFS'); });

    expect(() => projectBead(db.raw, { vaultPath, beadId: id })).toThrow();

    expect(logMock.error).toHaveBeenCalledTimes(1);
    const [fields, msg] = logMock.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/vault projection write failed/i);
    expect(fields.code).toBe('EROFS');
    expect(fields.projection).toBe('bead');
    expect(fields.path).toMatch(/\.md$/);
  });

  it('falls back to EIO when the thrown value carries no errno code', () => {
    const id = seedBead();
    fsMock.writeFileSync.mockImplementation(() => { throw new Error('no code'); });

    let caught: NodeJS.ErrnoException | undefined;
    try { projectBead(db.raw, { vaultPath, beadId: id }); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EIO');
  });

  // The discriminating case. Without it, "guard every fs call in this module"
  // passes every test above while destroying the deliberate best-effort
  // contract on stale-projection cleanup.
  it('leaves removeEntityProjection best-effort — a missing stale file is NOT an error', () => {
    const id = seedEntity();
    fsMock.unlinkSync.mockImplementation(() => { throw errno('ENOENT'); });

    expect(() => removeEntityProjection(db.raw, { vaultPath, entityId: id })).not.toThrow();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('returns the written path when the filesystem is healthy', () => {
    const id = seedBead();
    const out = projectBead(db.raw, { vaultPath, beadId: id });
    expect(out).toMatch(/\.md$/);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
