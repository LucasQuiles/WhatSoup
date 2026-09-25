/**
 * Type-level regression: the console copy of the recovery_debt feed detail
 * must match the wire shape the fleet feed route emits
 * (src/fleet/routes/feed.ts recoveryDebtEvent), which names the aggregate
 * `gaugeTotal`. A console field named anything else typechecks and renders
 * undefined. tsc over tsconfig.test.json is the enforcing check; the runtime
 * sample below is an anchor so the file also runs under vitest.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FeedDetail } from '../../console/src/types.ts';

type ConsoleRecoveryDebtDetail = Extract<FeedDetail, { type: 'recovery_debt' }>;

describe('console FeedDetail recovery_debt matches the feed wire shape', () => {
  it('names the aggregate gaugeTotal, as the server emits it', () => {
    expectTypeOf<ConsoleRecoveryDebtDetail>().toHaveProperty('gaugeTotal').toEqualTypeOf<number>();
    expectTypeOf<ConsoleRecoveryDebtDetail>().not.toHaveProperty('total');
    const sample = {
      type: 'recovery_debt',
      state: 'opened',
      serviceBlocking: false,
      attention: 'routine',
      reasons: ['historical_turn_catchup'],
      gaugeTotal: 1,
    } satisfies ConsoleRecoveryDebtDetail;
    expect(Object.keys(sample).sort()).toEqual([
      'attention',
      'gaugeTotal',
      'reasons',
      'serviceBlocking',
      'state',
      'type',
    ]);
  });
});
