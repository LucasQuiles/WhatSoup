/**
 * Drift guard: the console provider catalog and the server provider registry
 * must agree exactly.
 *
 * The fleet PATCH endpoint validates provider IDs against the server-side
 * PROVIDER_IDS registry (src/runtimes/agent/providers/index.ts). The console
 * renders its provider pickers from console/src/lib/providers.ts. If either
 * list changes alone, operators see confusing 400s on fleet PATCH (console
 * offers an ID the server rejects) or invisible providers (server supports an
 * ID the console never offers). This test pins the two surfaces together: it
 * fails if either side changes without the other.
 */
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
} from '../../src/runtimes/agent/providers/index.ts';
import {
  PROVIDERS,
  DEFAULT_PROVIDER_ID as CONSOLE_DEFAULT_PROVIDER_ID,
} from '../../console/src/lib/providers.ts';

describe('provider catalog drift guard (console vs server)', () => {
  it('console provider IDs match the server registry exactly, in order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('console default provider matches the server default', () => {
    expect(CONSOLE_DEFAULT_PROVIDER_ID).toBe(DEFAULT_PROVIDER_ID);
  });

  it('console catalog has no duplicate IDs', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
