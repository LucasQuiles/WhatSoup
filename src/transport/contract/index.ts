// src/transport/contract/index.ts
export * from './adapter.ts';
export * from './capabilities.ts';
export * from './commands.ts';
export * from './errors.ts';
export * from './error-codes.ts';
export * from './adapter-reason-codes.ts';
export * from './events.ts';
export * from './extensions.ts';
export * from './subscription.ts';

// Re-export domain refs from src/core for adapter convenience.
export type {
  ChannelKind, ChannelId,
  ConversationRef, ParticipantRef, MessageRef,
} from '../../core/transport-refs.ts';
export { makeChannelId, kindOf, accountOf, refToKey, msgToKey } from '../../core/transport-refs.ts';
