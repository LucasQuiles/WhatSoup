// src/transport/contract/capabilities.ts
import type { ChannelId, ChannelKind } from '../../core/transport-refs.ts';

export type ExtensionName =
  | 'media'
  | 'voice-notes'
  | 'reactions'
  | 'edit'
  | 'delete'
  | 'typing'
  | 'presence'
  | 'groups'
  | 'read-receipts'
  | 'inline-keyboards'
  | 'outbound-status';

export const ALL_EXTENSION_NAMES: readonly ExtensionName[] = [
  'media', 'voice-notes', 'reactions', 'edit', 'delete',
  'typing', 'presence', 'groups', 'read-receipts',
  'inline-keyboards', 'outbound-status',
] as const;

export type IdempotencyMode = 'none' | 'native' | 'simulated';

export interface IdempotencyDeclaration {
  readonly sendText:  IdempotencyMode;
  readonly sendMedia: IdempotencyMode;
  readonly react:     IdempotencyMode;
  readonly editText:  IdempotencyMode;
  readonly delete:    IdempotencyMode;
}

export interface MediaCapability {
  readonly maxBytes: number;
  readonly mimeAllowlist: ReadonlyArray<string>;
}

export interface Capabilities {
  readonly channel: ChannelId;            // per-account, e.g. 'whatsapp:mw-bot'
  readonly kind: ChannelKind;              // 'whatsapp' (derivable; duplicated for ergonomics)
  readonly extensions: ReadonlySet<ExtensionName>;
  readonly maxTextLength: number;
  readonly auth: 'qr' | 'token' | 'phone' | 'oauth';

  // Partial modes — adapter declares what it can actually do.
  readonly readReceipts: 'none' | 'conversation' | 'message';
  readonly reactions:    'none' | 'single' | 'multiple';
  readonly media: MediaCapability;
  readonly idempotency: IdempotencyDeclaration;
}
