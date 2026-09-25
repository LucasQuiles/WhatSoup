import { describe, expect, it } from 'vitest';
import {
  CATCHUP_RECONCILE_MAX_GROUP_LIMIT,
  resolveCatchupReconcileDep,
  validateTurnRecoveryCatchupReconcileConfig,
} from '../../src/core/turn-recovery-catchup-config.ts';

describe('agentOptions.turnRecoveryCatchupReconcile — validation', () => {
  it.each([
    ['absent', undefined],
    ['disabled', { enabled: false }],
    ['enabled without a limit', { enabled: true }],
    ['enabled with a limit', { enabled: true, groupLimit: 10 }],
    ['disabled with a limit', { enabled: false, groupLimit: 10 }],
    ['limit at the ceiling', { enabled: true, groupLimit: CATCHUP_RECONCILE_MAX_GROUP_LIMIT }],
  ])('accepts %s', (_label, value) => {
    expect(validateTurnRecoveryCatchupReconcileConfig(value)).toBeNull();
  });

  it.each([
    ['null', null, 'agentOptions.turnRecoveryCatchupReconcile'],
    ['a bare boolean', true, 'agentOptions.turnRecoveryCatchupReconcile'],
    ['an array', [], 'agentOptions.turnRecoveryCatchupReconcile'],
    ['a missing enabled', { groupLimit: 10 }, 'agentOptions.turnRecoveryCatchupReconcile.enabled'],
    ['a string enabled', { enabled: 'true' }, 'agentOptions.turnRecoveryCatchupReconcile.enabled'],
    ['a numeric enabled', { enabled: 1 }, 'agentOptions.turnRecoveryCatchupReconcile.enabled'],
    ['a misspelled key', { enabled: true, groupLimt: 10 }, 'agentOptions.turnRecoveryCatchupReconcile'],
    ['a zero limit', { enabled: true, groupLimit: 0 }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
    ['a negative limit', { enabled: true, groupLimit: -1 }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
    ['a fractional limit', { enabled: true, groupLimit: 1.5 }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
    ['a string limit', { enabled: true, groupLimit: '10' }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
    ['an infinite limit', { enabled: true, groupLimit: Number.POSITIVE_INFINITY }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
    ['a NaN limit', { enabled: true, groupLimit: Number.NaN }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
    ['a limit above the ceiling', { enabled: true, groupLimit: CATCHUP_RECONCILE_MAX_GROUP_LIMIT + 1 }, 'agentOptions.turnRecoveryCatchupReconcile.groupLimit'],
  ])('rejects %s', (_label, value, field) => {
    expect(validateTurnRecoveryCatchupReconcileConfig(value)).toMatchObject({ field });
  });
});

describe('agentOptions.turnRecoveryCatchupReconcile — supervisor dependency', () => {
  it('is off (null) when the block is absent or disabled', () => {
    expect(resolveCatchupReconcileDep(undefined)).toBeNull();
    expect(resolveCatchupReconcileDep(null)).toBeNull();
    expect(resolveCatchupReconcileDep({ enabled: false })).toBeNull();
    expect(resolveCatchupReconcileDep({ enabled: false, groupLimit: 5 })).toBeNull();
  });

  it('is on with the reconciler default limit when enabled without a limit', () => {
    expect(resolveCatchupReconcileDep({ enabled: true })).toEqual({});
  });

  it('forwards an explicit limit when enabled', () => {
    expect(resolveCatchupReconcileDep({ enabled: true, groupLimit: 7 })).toEqual({ groupLimit: 7 });
  });
});
