// src/transport/contract/adapter.ts
import type { ParticipantRef, ConversationRef, MessageRef } from '../../core/transport-refs.ts';
import type { Capabilities } from './capabilities.ts';
import type { InboundMessage } from './events.ts';
import type { TransportError } from './errors.ts';
import type { Subscription } from './subscription.ts';
import type { SendTextOptions } from './commands.ts';

// Canonical adapter operational-health union (#2201). This models HOW the
// adapter is doing — deliberately distinct from ConnectionLifecycleState
// (transport/connection.ts), which models the socket's connect/disconnect
// phase. The two axes share only 'connected'/'disconnected' by design; the
// arch-ratchet test (tests/scripts/connection-state-union-ssot.test.ts)
// asserts that declared overlap so neither side can drift silently.
export const ALL_ADAPTER_STATES = [
  'starting',
  'connected',
  'degraded',
  'disconnected',
  'auth_required',
  'rate_limited',
  'exhausted',
  'stopping',
] as const;

export type AdapterState = (typeof ALL_ADAPTER_STATES)[number];

/** Type-narrow for values crossing an untyped boundary (logs, JSON, IPC). */
export function isAdapterState(value: unknown): value is AdapterState {
  return typeof value === 'string'
    && (ALL_ADAPTER_STATES as readonly string[]).includes(value);
}

export interface AdapterHealth {
  readonly state: AdapterState;
  readonly reasonCode?: string;
  readonly since: Date;
}

export interface TransportAdapter {
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

  on(event: 'message',  handler: (e: InboundMessage)  => void): Subscription;
  on(event: 'state',    handler: (e: AdapterHealth)   => void): Subscription;
  on(event: 'error',    handler: (e: TransportError)  => void): Subscription;
}
