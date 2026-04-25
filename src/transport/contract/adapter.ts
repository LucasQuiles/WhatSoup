// src/transport/contract/adapter.ts
import type { ParticipantRef, ConversationRef, MessageRef } from '../../core/transport-refs.ts';
import type { Capabilities } from './capabilities.ts';
import type { InboundMessage } from './events.ts';
import type { TransportError } from './errors.ts';
import type { Subscription } from './subscription.ts';
import type { SendTextOptions } from './commands.ts';

export type AdapterState =
  | 'starting'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'auth_required'
  | 'rate_limited'
  | 'exhausted'
  | 'stopping';

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
