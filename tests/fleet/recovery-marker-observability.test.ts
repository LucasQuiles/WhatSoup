import { beforeEach, describe, expect, it, vi } from 'vitest';

const markerStore = vi.hoisted(() => ({
  setRecoveryMarker: vi.fn(),
  clearRecoveryMarker: vi.fn(),
}));
const logger = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../src/lib/recovery-authority-store.ts', () => markerStore);
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => logger,
}));

import {
  clearRecoveryMarkerObserved,
  setRecoveryMarkerObserved,
} from '../../src/fleet/recovery-marker-observability.ts';

describe('recovery marker observability', () => {
  beforeEach(() => {
    markerStore.setRecoveryMarker.mockReset();
    markerStore.clearRecoveryMarker.mockReset();
    logger.warn.mockReset();
  });

  it('persists the scoped marker on a successful write', () => {
    setRecoveryMarkerObserved('remote-1', 'recovery_debt_attention');

    expect(markerStore.setRecoveryMarker).toHaveBeenCalledWith(
      'remote-1:recovery_debt_attention',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs marker write failures with instance and source identity', () => {
    const err = new Error('marker write denied');
    markerStore.setRecoveryMarker.mockImplementationOnce(() => { throw err; });

    setRecoveryMarkerObserved('remote-1', 'recovery_debt_attention');

    expect(logger.warn).toHaveBeenCalledWith(
      { err, name: 'remote-1', source: 'recovery_debt_attention' },
      'recovery authority marker write failed',
    );
  });

  it('logs marker clear failures with instance and source identity', () => {
    const err = new Error('marker clear denied');
    markerStore.clearRecoveryMarker.mockImplementationOnce(() => { throw err; });

    clearRecoveryMarkerObserved('remote-1', 'recovery_debt_attention');

    expect(logger.warn).toHaveBeenCalledWith(
      { err, name: 'remote-1', source: 'recovery_debt_attention' },
      'recovery authority marker clear failed',
    );
  });
});
