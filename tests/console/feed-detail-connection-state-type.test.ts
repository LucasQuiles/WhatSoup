/**
 * Type-level regression for #2201 (SSOT drift between the three
 * connection-state unions). `console/src/types.ts`'s `FeedDetail` 'connection'
 * variant's `state` field tracks the full `ConnectionLifecycleState` domain
 * declared once in `src/transport/connection.ts`. (Pre-#2892 this tracked a
 * hand-mirrored copy of `src/fleet/routes/feed.ts`'s own inline literal;
 * #2892 moved feed.ts to a compile-checked, narrower 3-value subset of this
 * same canonical union, so the console copy now tracks the canonical union
 * directly rather than feed.ts.) This asserts the console copy's `state`
 * type equals `ConnectionLifecycleState` exactly, so a future edit that
 * narrows or widens the console copy without updating it to match the
 * canonical union fails type-check here instead of silently drifting.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FeedDetail } from '../../console/src/types.ts';
import {
  CONNECTION_LIFECYCLE_STATES,
  type ConnectionLifecycleState,
} from '../../src/transport/connection.ts';

type ConsoleConnectionState = NonNullable<Extract<FeedDetail, { type: 'connection' }>['state']>;

describe('#2201 console FeedDetail connection state matches ConnectionLifecycleState', () => {
  it('accepts every ConnectionLifecycleState value on the connection variant', () => {
    expectTypeOf<ConnectionLifecycleState>().toEqualTypeOf<ConsoleConnectionState>();
    // Runtime anchor on the canonical declaration the type test derives from:
    // a state added to (or removed from) CONNECTION_LIFECYCLE_STATES moves
    // these counts, forcing this file to be revisited alongside the union.
    expect(CONNECTION_LIFECYCLE_STATES).toHaveLength(6);
    expect(new Set(CONNECTION_LIFECYCLE_STATES).size).toBe(6);
    for (const state of CONNECTION_LIFECYCLE_STATES) {
      const sample: ConsoleConnectionState = state;
      expect(sample).toBe(state);
    }
  });
});
