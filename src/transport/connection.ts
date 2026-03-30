// src/transport/connection.ts
// Connection manager interface stub — full implementation in a later task.

import type { Messenger } from '../core/types.ts';

export interface ConnectionManager extends Messenger {
  /** The bot's own JID once connected, null before authentication. */
  botJid: string | null;

  /** The bot's LID (linked-device ID), null if not yet known. */
  botLid: string | null;

  /** Connect (or reconnect) to WhatsApp. */
  connect(): Promise<void>;

  /** Gracefully disconnect. */
  disconnect(): Promise<void>;
}
