import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ALL_ADAPTER_STATES,
  type AdapterState,
  type AdapterHealth,
  type TransportAdapter,
} from '../../../src/transport/contract/adapter.ts';
import type { Capabilities } from '../../../src/transport/contract/capabilities.ts';
import type { Subscription } from '../../../src/transport/contract/subscription.ts';
import type { InboundMessage } from '../../../src/transport/contract/events.ts';
import type { TransportError } from '../../../src/transport/contract/errors.ts';
import type {
  ParticipantRef,
  ConversationRef,
  MessageRef,
} from '../../../src/core/transport-refs.ts';
import type { SendTextOptions } from '../../../src/transport/contract/commands.ts';

// Derived, not hand-mirrored: a state added to ALL_ADAPTER_STATES flows in here
// automatically, and the explicit length assertions below go loud instead of
// silently under-covering it (the pre-#2892 hand-array satisfied `readonly
// AdapterState[]` even when incomplete).
const VALID_STATES = ALL_ADAPTER_STATES;

function makeStubAdapter(initialState: AdapterState = 'connected'): TransportAdapter {
  const startedAt = new Date();
  return {
    capabilities: {} as Capabilities,
    connect: async () => undefined,
    disconnect: async () => undefined,
    state: () => ({ state: initialState, since: startedAt }),
    selfRef: () => ({} as ParticipantRef),
    sendText: async () => ({} as MessageRef),
    on: () => ({ dispose: () => undefined }),
  };
}

describe('AdapterState union', () => {
  it('contains the expected 8 lifecycle states', () => {
    expect(VALID_STATES).toHaveLength(8);
    expect(new Set(VALID_STATES).size).toBe(8);
  });

  it.each(VALID_STATES)('accepts %s as a valid AdapterState in an AdapterHealth literal', (state) => {
    const h: AdapterHealth = { state, since: new Date() };
    expect(h.state).toBe(state);
    expect(VALID_STATES).toContain(h.state);
  });

  it('AdapterState union is statically equivalent to the expected literal union', () => {
    expectTypeOf<AdapterState>().toEqualTypeOf<
      | 'starting'
      | 'connected'
      | 'degraded'
      | 'disconnected'
      | 'auth_required'
      | 'rate_limited'
      | 'exhausted'
      | 'stopping'
    >();
    expect(VALID_STATES).toContain<AdapterState>('connected');
  });
});

describe('AdapterHealth shape', () => {
  it('requires state and since fields; reasonCode is optional', () => {
    const minimal: AdapterHealth = { state: 'connected', since: new Date() };
    expect(minimal.state).toBe('connected');
    expect(minimal.since).toBeInstanceOf(Date);
    expect(minimal.reasonCode).toBeUndefined();

    const full: AdapterHealth = {
      state: 'degraded',
      since: new Date(),
      reasonCode: 'BACKOFF',
    };
    expect(full.reasonCode).toBe('BACKOFF');
    expect(full.state).toBe('degraded');
  });

  it('state field accepts every AdapterState value', () => {
    expectTypeOf<AdapterHealth['state']>().toEqualTypeOf<AdapterState>();
    for (const state of VALID_STATES) {
      const sample: AdapterHealth = { state, since: new Date() };
      expect(sample.state).toBe(state);
    }
  });

  it('since field stores a Date instance', () => {
    expectTypeOf<AdapterHealth['since']>().toEqualTypeOf<Date>();
    const ts = new Date('2026-01-01T00:00:00Z');
    const sample: AdapterHealth = { state: 'connected', since: ts };
    expect(sample.since.getTime()).toBe(ts.getTime());
  });

  it('reasonCode is optional string', () => {
    expectTypeOf<AdapterHealth['reasonCode']>().toEqualTypeOf<string | undefined>();
    const a: AdapterHealth = { state: 'connected', since: new Date() };
    const b: AdapterHealth = { state: 'connected', since: new Date(), reasonCode: 'X' };
    expect(a.reasonCode).toBeUndefined();
    expect(b.reasonCode).toBe('X');
  });
});

describe('TransportAdapter contract', () => {
  it('exposes the documented method surface', () => {
    const stub = makeStubAdapter();
    expect(typeof stub.connect).toBe('function');
    expect(typeof stub.disconnect).toBe('function');
    expect(typeof stub.state).toBe('function');
    expect(typeof stub.selfRef).toBe('function');
    expect(typeof stub.sendText).toBe('function');
    expect(typeof stub.on).toBe('function');
    expect('capabilities' in stub).toBe(true);
  });

  it('matches the documented compile-time surface', () => {
    expectTypeOf<TransportAdapter>().toMatchTypeOf<{
      readonly capabilities: Capabilities;
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      state(): AdapterHealth;
      selfRef(): ParticipantRef;
      sendText(
        target: ConversationRef,
        text: string,
        opts?: SendTextOptions,
      ): Promise<MessageRef>;
    }>();
    const stub = makeStubAdapter('starting');
    expect(stub.state().state).toBe('starting');
  });

  it('on() returns a Subscription regardless of which event was registered', () => {
    expectTypeOf<ReturnType<TransportAdapter['on']>>().toEqualTypeOf<Subscription>();
    const stub = makeStubAdapter();
    const sub = stub.on('message', () => undefined);
    expect(typeof sub.dispose).toBe('function');
  });

  it('on accepts the documented event names', () => {
    const events = ['message', 'state', 'error'] as const;
    expect(events).toHaveLength(3);
    expect(new Set(events).size).toBe(3);
  });

  it('event handler payload types match per-event overloads', () => {
    const stub = makeStubAdapter();
    const messageSub = stub.on('message', (e) => {
      expectTypeOf(e).toEqualTypeOf<InboundMessage>();
    });
    const stateSub = stub.on('state', (e) => {
      expectTypeOf(e).toEqualTypeOf<AdapterHealth>();
    });
    const errorSub = stub.on('error', (e) => {
      expectTypeOf(e).toEqualTypeOf<TransportError>();
    });

    expectTypeOf(messageSub).toEqualTypeOf<Subscription>();
    expectTypeOf(stateSub).toEqualTypeOf<Subscription>();
    expectTypeOf(errorSub).toEqualTypeOf<Subscription>();
  });

  it('a satisfying implementer is assignable to TransportAdapter', async () => {
    const stub = {
      capabilities: {} as Capabilities,
      connect: async () => undefined,
      disconnect: async () => undefined,
      state: () => ({ state: 'connected' as AdapterState, since: new Date() }),
      selfRef: () => ({} as ParticipantRef),
      sendText: async () => ({} as MessageRef),
      on: () => ({ dispose: () => undefined }),
    } satisfies TransportAdapter;

    await expect(stub.connect()).resolves.toBeUndefined();
    await expect(stub.disconnect()).resolves.toBeUndefined();
    expect(stub.state().state).toBe('connected');
  });
});
