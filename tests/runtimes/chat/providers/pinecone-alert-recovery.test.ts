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
  clearAlertSourceChecked: mockClearAlertSourceChecked,
}));

vi.mock('../../../../src/logger.ts', async () => (await import('../../../helpers/logger-mock.ts')).loggerMock());

vi.mock('../../../../src/config.ts', () => ({
  config: { botName: 'test-bot' },
}));

// ── import after mocks ───────────────────────────────────────────────────────

import type { MemoryOperation, MemoryOperationFailure } from '../../../../src/lib/memory-operation-telemetry.ts';
import { _testing } from '../../../../src/runtimes/chat/providers/pinecone.ts';

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
