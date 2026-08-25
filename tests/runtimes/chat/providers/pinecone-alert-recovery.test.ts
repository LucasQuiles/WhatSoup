/**
 * #2412 falsifier: pinecone_degraded contributor-aware recovery contract.
 *
 * The pinecone provider owns ONE asset-wide `pinecone_degraded` source shared
 * across several operations (search / entity_search / rerank / upsert). The
 * source must clear only after EVERY alerted contributor has recovered, and
 * contributor membership must be armed/disarmed only when the durable alert
 * enqueue actually accepts the event.
 *
 * These cases drive the module-local state machine directly via the `_testing`
 * surface (mirrors the openai-whisper precedent), mocking `emit-alert.ts` so
 * the checked-boundary boolean returns are observable + controllable. The real
 * `trackFailure` / `trackSuccess` transitions + the real breaker threshold (3)
 * are exercised — no SDK / retry machinery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted mocks ────────────────────────────────────────────────────────────

const { mockEmitAlertChecked, mockClearAlertSourceChecked } = vi.hoisted(() => ({
  mockEmitAlertChecked: vi.fn(),
  mockClearAlertSourceChecked: vi.fn(),
}));

vi.mock('../../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: mockEmitAlertChecked,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: mockClearAlertSourceChecked,
}));

vi.mock('../../../../src/logger.ts', async () => (await import('../../../helpers/logger-mock.ts')).loggerMock());

vi.mock('../../../../src/config.ts', () => ({
  config: { botName: 'test-bot' },
}));

// ── import after mocks ───────────────────────────────────────────────────────

import type { MemoryOperation, MemoryOperationFailure } from '../../../../src/lib/memory-operation-telemetry.ts';
import { _testing } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import { loadRecoveryMarkers } from '../../../../src/lib/recovery-authority-store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── helpers ──────────────────────────────────────────────────────────────────

const FAILURE: MemoryOperationFailure = {
  code: 'unknown',
  retryable: true,
};

/**
 * Trip an operation's circuit breaker past its threshold (3) so the alert path
 * fires exactly once. Mirrors how the real SDK flow arms contributor membership.
 */
function tripBreaker(operation: MemoryOperation): void {
  for (let i = 0; i < 3; i++) {
    _testing.trackFailure(operation, `op-${operation}-${i}`, FAILURE, 2);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  _testing.reset();
  // By default both checked boundaries accept the event durably.
  mockEmitAlertChecked.mockReturnValue(true);
  mockClearAlertSourceChecked.mockReturnValue(true);
});

afterEach(() => {
  _testing.reset();
});

describe('#2412 — contributor-aware recovery', () => {
  it('does NOT clear the global source when a sibling contributor remains degraded', () => {
    // Trip search AND upsert so two contributors share the asset-wide source.
    tripBreaker('search');
    tripBreaker('upsert');

    expect(_testing.alertedOperations().sort()).toEqual(['search', 'upsert']);
    // One alert per operation (fires on the threshold-crossing 3rd failure).
  expect(mockEmitAlertChecked).toHaveBeenCalledTimes(2);

    // Recover search only — upsert is still degraded.
    _testing.trackSuccess('search');

    // Falsifier: the global clear must NOT fire while upsert remains a contributor.
    expect(mockClearAlertSourceChecked).not.toHaveBeenCalled();
    // search left the contributor set; upsert retains clear authority.
    expect(_testing.alertedOperations()).toEqual(['upsert']);
  });

  it('clears the global source exactly ONCE when the final contributor recovers', () => {
    tripBreaker('search');
    tripBreaker('upsert');

    _testing.trackSuccess('search'); // sibling remains → no clear
    expect(mockClearAlertSourceChecked).not.toHaveBeenCalled();

    _testing.trackSuccess('upsert'); // final contributor → exactly one clear
    expect(mockClearAlertSourceChecked).toHaveBeenCalledTimes(1);
    expect(mockClearAlertSourceChecked).toHaveBeenCalledWith('test-bot', 'pinecone_degraded');
    expect(_testing.alertedOperations()).toEqual([]);
  });
});

describe('#2412 — durable enqueue governs membership', () => {
  it('does NOT arm contributor membership when the alert enqueue fails', () => {
    // The checked boundary rejects — the incident was not durably opened.
    mockEmitAlertChecked.mockReturnValue(false);

    tripBreaker('search'); // breaker opens on the 3rd failure → emit rejected

    // Falsifier: a failed alert enqueue must not arm local clear authority.
    expect(mockEmitAlertChecked).toHaveBeenCalledTimes(1);
    expect(_testing.alertedOperations()).toEqual([]);

    // A later success must not attempt to clear an incident that never landed.
    _testing.trackSuccess('search');
    expect(mockClearAlertSourceChecked).not.toHaveBeenCalled();
  });

  it('RETAINS contributor membership when the clear enqueue fails (retry authority)', () => {
    tripBreaker('search');
    expect(_testing.alertedOperations()).toEqual(['search']);

    // The final-contributor clear is rejected by the durable boundary.
    mockClearAlertSourceChecked.mockReturnValue(false);
    _testing.trackSuccess('search');

    // The clear attempt fired…
    expect(mockClearAlertSourceChecked).toHaveBeenCalledTimes(1);
    // …but because it failed, membership is retained for bounded retry.
    expect(_testing.alertedOperations()).toEqual(['search']);
  });
});

describe('#2412 remainder — restart-durable contributor membership', () => {
  let markerDir: string;
  let savedStateDir: string | undefined;

  const MARKER_PREFIX = 'pinecone_degraded:test-bot#';

  function pineconeMarkers(): string[] {
    return [...loadRecoveryMarkers()].filter((k) => k.startsWith(MARKER_PREFIX)).sort();
  }

  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), 'pinecone-markers-'));
    savedStateDir = process.env['BOT_ERRORS_STATE_DIR'];
    process.env['BOT_ERRORS_STATE_DIR'] = markerDir;
    _testing.reset();
    mockEmitAlertChecked.mockReturnValue(true);
    mockClearAlertSourceChecked.mockReturnValue(true);
  });

  afterEach(() => {
    _testing.reset();
    if (savedStateDir === undefined) delete process.env['BOT_ERRORS_STATE_DIR'];
    else process.env['BOT_ERRORS_STATE_DIR'] = savedStateDir;
    rmSync(markerDir, { recursive: true, force: true });
  });

  it('R1: accepted contributors persist markers; restart restores membership; full recovery clears once', () => {
    tripBreaker('search');
    tripBreaker('upsert');
    expect(pineconeMarkers()).toEqual([`${MARKER_PREFIX}search`, `${MARKER_PREFIX}upsert`]);

    // "Restart": wipe in-memory state only, then run the load-time reconcile.
    _testing.reset({ keepMarkers: true });
    _testing.reconcileFromMarkers();
    expect(_testing.alertedOperations().sort()).toEqual(['search', 'upsert']);

    _testing.trackSuccess('search');
    expect(mockClearAlertSourceChecked).not.toHaveBeenCalled();
    _testing.trackSuccess('upsert');
    expect(mockClearAlertSourceChecked).toHaveBeenCalledTimes(1);
    expect(pineconeMarkers()).toEqual([]);
  });

  it('R2: restart mid-degraded — one recovered contributor must NOT clear while a restored sibling remains', () => {
    tripBreaker('search');
    tripBreaker('upsert');
    _testing.reset({ keepMarkers: true });
    _testing.reconcileFromMarkers();

    _testing.trackSuccess('search');
    expect(mockClearAlertSourceChecked).not.toHaveBeenCalled();
    expect(_testing.alertedOperations()).toEqual(['upsert']);
  });

  it('R3: a rejected alert enqueue writes no marker (no phantom restart authority)', () => {
    mockEmitAlertChecked.mockReturnValue(false);
    tripBreaker('search');
    expect(_testing.alertedOperations()).toEqual([]);
    expect(pineconeMarkers()).toEqual([]);
  });

  it('R4: a rejected FINAL clear restores both membership and its marker', () => {
    tripBreaker('search');
    expect(pineconeMarkers()).toEqual([`${MARKER_PREFIX}search`]);
    mockClearAlertSourceChecked.mockReturnValue(false);
    _testing.trackSuccess('search');
    expect(_testing.alertedOperations()).toEqual(['search']);
    expect(pineconeMarkers()).toEqual([`${MARKER_PREFIX}search`]);
  });

  it('R5: non-final contributor recovery drops its own marker but keeps the siblings', () => {
    tripBreaker('search');
    tripBreaker('upsert');
    _testing.trackSuccess('search');
    expect(mockClearAlertSourceChecked).not.toHaveBeenCalled();
    expect(pineconeMarkers()).toEqual([`${MARKER_PREFIX}upsert`]);
  });
});
