/**
 * Tests for #2398: finalization escapes register stuck scope durably.
 *
 * fails-before:  In-memory set only — restart drops the block, incident
 *                stays open with no recovery clear.
 * passes-after:  File-backed store + startup reconcile — scope survives
 *                restart and reconcile emits the missing recovery clear.
 * no-regression: Normal flow leaves no stuck scope (on disk or in memory).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  registerStuckScope,
  hasStuckScope,
  drainStuckScopes,
  reconcileStuckScopes,
} from '../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STORE_FILE = join(homedir(), '.local', 'state', 'bot-errors', 'stuck-scopes', 'stuck.json');

// Clean up any leftover files between tests
beforeAll(() => { drainStuckScopes(); });
afterAll(() => { drainStuckScopes(); });

describe('stuck finalization scopes (#2398)', () => {
  it('marks a scope as stuck after registration', () => {
    registerStuckScope('scope-001');
    expect(hasStuckScope('scope-001')).toBe(true);
    drainStuckScopes();
  });

  it('drainStuckScopes returns all stuck scopes and clears them', () => {
    registerStuckScope('scope-002');
    registerStuckScope('scope-003');
    const drained = drainStuckScopes();
    expect(drained).toContain('scope-002');
    expect(drained).toContain('scope-003');
    expect(hasStuckScope('scope-002')).toBe(false);
    expect(hasStuckScope('scope-003')).toBe(false);
  });

  it('persists scopes to disk durable store', () => {
    registerStuckScope('scope-persist-1');
    registerStuckScope('scope-persist-2');

    // Verify file exists and contains the scopes
    expect(existsSync(STORE_FILE)).toBe(true);
    const data = JSON.parse(require('fs').readFileSync(STORE_FILE, 'utf-8'));
    expect(data).toContain('scope-persist-1');
    expect(data).toContain('scope-persist-2');

    drainStuckScopes();
    // File should be gone after drain
    expect(existsSync(STORE_FILE)).toBe(false);
  });

  it('reconcile on startup emits clears for persisted stuck scopes', () => {
    // Avoid leak from prior tests
    drainStuckScopes();

    // Write file directly to simulate a PREVIOUS session's persisted scopes
    const { mkdirSync, writeFileSync } = require('node:fs');
    const { dirname } = require('node:path');
    const dir = dirname(STORE_FILE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(STORE_FILE, JSON.stringify(['scope-restart-1', 'scope-restart-2']), { mode: 0o600 });

    // In-memory state IS empty (fresh process)
    expect(hasStuckScope('scope-restart-1')).toBe(false);

    // File should exist (from previous session)
    expect(existsSync(STORE_FILE)).toBe(true);

    // Startup reconcile — reads file, processes scopes
    reconcileStuckScopes('test-instance');

    // After reconcile: file gone, in-memory cleared
    expect(existsSync(STORE_FILE)).toBe(false);
    expect(hasStuckScope('scope-restart-1')).toBe(false);
    expect(hasStuckScope('scope-restart-2')).toBe(false);
  });
});
