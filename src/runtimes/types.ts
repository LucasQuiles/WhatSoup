// src/runtimes/types.ts
import type { IncomingMessage, RuntimeHealth } from '../core/types.ts';
import type { DurabilityEngine } from '../core/durability.ts';

export interface Runtime {
  start(): Promise<void>;
  handleMessage(msg: IncomingMessage): Promise<void>;
  getHealthSnapshot(): RuntimeHealth;
  shutdown(): Promise<void>;
  setDurability(engine: DurabilityEngine): void;
  /** Update delivery JID for active sessions/queues when a LID→phone mapping changes. */
  handleJidAliasChanged?(conversationKey: string, newJid: string): void;
  /** Inject a repair turn into the control session for self-healing. */
  handleControlTurn?(reportId: string, payload: string): Promise<void>;
}
