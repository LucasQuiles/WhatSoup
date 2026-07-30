// src/transport/runtime-connection.ts
// Minimal runtime connection surface consumed by main.ts and its dependents.
// Implemented by ConnectionManager (Baileys) and TwilioConnection (SMS bridge).
// Consumers typed against ConnectionManager directly must be widened to this
// interface to allow transport selection at startup.

import type { EventEmitter } from 'node:events';
import type { IncomingMessage, Messenger, SubmissionReceipt } from '../core/types.ts';
import type { IdentityStore, GuardMode } from '../core/outbound-identity/types.ts';
import type { ContactsDirectory } from '../core/mentions.ts';
import type { PresenceCache } from './presence-cache.ts';
import type { WhatsAppSocket, ConnectionStateSnapshot } from './connection.ts';
import type { OutboundBannerClassifier } from './outbound-content-egress.ts';

export function isFullyConnected(
  snapshot: { connected: unknown; state: unknown },
): boolean {
  return snapshot.connected === true && snapshot.state === 'connected';
}

/**
 * Minimal runtime connection surface consumed by main.ts and its dependents.
 * Implemented by ConnectionManager (Baileys) and TwilioConnection (SMS bridge).
 */
export interface RuntimeConnection extends EventEmitter, Messenger {
  /** Bot's sender identity — null before connect(). */
  botJid: string | null;
  /** Bot's LID — null for transports that don't use LIDs. */
  botLid: string | null;
  /** Callback invoked for every parsed incoming message. Set by the ingest layer. */
  onMessage: ((msg: IncomingMessage) => void) | null;
  /** Contacts directory for @mention resolution and history seeding. */
  readonly contactsDir: ContactsDirectory;
  /** In-memory presence cache. */
  readonly presenceCache: PresenceCache;
  /** Underlying socket — null for non-Baileys transports. Callers must null-check. */
  getSocket(): WhatsAppSocket | null;
  /** Returns the current bounded connection state snapshot. */
  getConnectionState(): ConnectionStateSnapshot;
  /** Inject the outbound identity store + guard mode. Wired post-construction in main.ts. */
  setIdentityStore(store: IdentityStore, mode: GuardMode): void;
  /**
   * Wire the send-seam provider-error banner classifier (#1783). Optional: only
   * the Baileys `ConnectionManager` runs an outbound governor; Twilio omits it.
   */
  setOutboundContentClassifier?(classify: OutboundBannerClassifier): void;
  connect(): Promise<void>;
  shutdown(): void;
  sendRaw(chatJid: string, content: Record<string, unknown>): Promise<SubmissionReceipt>;
  sendPollMessage(
    chatJid: string,
    name: string,
    values: string[],
    selectableCount: number,
  ): Promise<{ waMessageId: string | null; hasSecret: boolean }>;
}
