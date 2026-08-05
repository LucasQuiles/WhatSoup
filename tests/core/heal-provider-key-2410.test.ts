/**
 * Tests for #2410: crash single-flight key includes provider.
 *
 * Production path: emitHealReport → projectAutomaticHealEvidence → errorClassForHealEvidence
 *
 * fails-before:  Two providers (A, B) crash with same class → error class is
 *                "crash__provider_auth_required" for both → B's crash conflated into A's report.
 * passes-after:  Provider in error class → A's key "crash__provider_auth_required__providerA",
 *                B's key "crash__provider_auth_required__providerB" → distinct single-flight slots.
 * no-regression: No provider → key is "crash__provider_auth_required" (existing behavior).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — registered before imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    controlPeers: new Map<string, string>([['q', '15559998888']]),
    adminPhones: new Set<string>(),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-6',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'gpt-5.4',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource: vi.fn(() => true),
    clearAlertSourceChecked: vi.fn(() => true),
  };
});

vi.mock('../../src/core/durability.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/core/durability.ts');
  return {
    ...actual,
    sendTracked: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import type { Messenger } from '../../src/core/types.ts';
import { emitHealReport } from '../../src/core/heal.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

describe('provider key in heal report error class (#2410)', () => {
  let db: Database;
  let messenger: Messenger;

  beforeEach(() => {
    db = makeDb();
    messenger = makeMessenger();
  });

  afterEach(() => {
    db.close();
  });

  it('includes provider in error class via production path', () => {
    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
      provider: 'openai',
    });
    expect(reportId).not.toBeNull();
    const row = db.raw.prepare(
      'SELECT error_class FROM heal_reports WHERE report_id = ?',
    ).get(reportId!) as { error_class: string };
    expect(row).toBeDefined();
    expect(row.error_class).toBe('crash__provider_auth_required__openai');
  });

  it('excludes provider from error class when absent', () => {
    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
    });
    expect(reportId).not.toBeNull();
    const row = db.raw.prepare(
      'SELECT error_class FROM heal_reports WHERE report_id = ?',
    ).get(reportId!) as { error_class: string };
    expect(row).toBeDefined();
    expect(row.error_class).toBe('crash__provider_auth_required');
  });

  it('different providers produce different error classes', () => {
    const idA = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
      provider: 'providerA',
    });
    const idB = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
      provider: 'providerB',
    });
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    const rowA = db.raw.prepare(
      'SELECT error_class FROM heal_reports WHERE report_id = ?',
    ).get(idA!) as { error_class: string };
    const rowB = db.raw.prepare(
      'SELECT error_class FROM heal_reports WHERE report_id = ?',
    ).get(idB!) as { error_class: string };
    expect(rowA.error_class).not.toBe(rowB.error_class);
  });

  it('same provider and crash class produce same error class', () => {
    const id1 = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
      provider: 'openai',
    });
    expect(id1).not.toBeNull();
    const row1 = db.raw.prepare(
      'SELECT error_class FROM heal_reports WHERE report_id = ?',
    ).get(id1!) as { error_class: string };
    expect(row1.error_class).toBe('crash__provider_auth_required__openai');

    // Second call with same params: single-flight should suppress → null return
    const id2 = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
      provider: 'openai',
    });
    expect(id2).toBeNull();
  });
});
