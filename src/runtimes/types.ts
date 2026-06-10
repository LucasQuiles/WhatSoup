// src/runtimes/types.ts
import type { IncomingMessage, RuntimeHealth } from '../core/types.ts';
import type { DurabilityEngine } from '../core/durability.ts';

export interface AgentCommandRequest {
  command: 'compact';
  /** Required for per-chat agent runtimes so control-plane calls target one session. */
  chatJid?: string;
  /** Suppress user-facing compact notifications and any command output when true. */
  silent?: boolean;
}

export interface AgentCommandResult {
  ok: true;
  command: 'compact';
  chatJid: string | null;
  silent: boolean;
}

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
  /** Execute an internal agent command without routing through WhatsApp ingest. */
  handleAgentCommand?(request: AgentCommandRequest): Promise<AgentCommandResult>;
  /**
   * Provider-fallback observability (agent runtimes only). Returns the
   * currently effective provider and the epoch-ms expiry of an active fallback
   * window (`null` when running on the primary provider).
   */
  getFallbackState?(): { effectiveProvider: string; fallbackActiveUntil: number | null };
}
