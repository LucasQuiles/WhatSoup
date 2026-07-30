// src/runtimes/types.ts
import type { IncomingMessage, RuntimeHealth } from '../core/types.ts';
import type { DurabilityEngine } from '../core/durability.ts';
import type { AgentFallbackEntry } from '../core/fallback-chain.ts';
import type { ToolDurabilityTelemetrySnapshot } from '../core/durability-evidence-contract.ts';
import type { StartupNotificationEvent } from '../core/startup-notification-controller.ts';

export interface RuntimeTurnCapabilityHealth {
  modelUsable: boolean | null;
  /**
   * True when the last probe said `usable` but is older than the freshness
   * window, so `modelUsable` is downgraded to `null` (unknown) rather than a
   * stale green. Prevents /health and monitors from reading a `modelUsable=true`
   * off a probe that is hours out of date. See RCA 2026-06-24.
   */
  modelUsableStale: boolean;
  /** Epoch ms of the usability probe behind `modelUsable` (null if never probed). */
  modelUsableCheckedAt: number | null;
  modelUsabilityStatus: string | null;
  lastSuccessfulTurnAt: number | null;
  lastTurnErrorClass: string | null;
  lastTurnErrorAt: number | null;
}

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

export type RuntimeAdmissionReceipt =
  | { status: 'accepted' }
  | {
      status: 'rejected';
      reason: 'queue_full';
      durableDisposition: 'failed' | 'unowned';
    };

export interface Runtime {
  start(): Promise<void>;
  handleMessage(msg: IncomingMessage): Promise<void | RuntimeAdmissionReceipt>;
  getHealthSnapshot(): RuntimeHealth;
  shutdown(): Promise<void>;
  setDurability(engine: DurabilityEngine): void;
  /** Agent runtimes expose at most one deferred startup event for main's controller. */
  popStartupNotificationEvent?(): StartupNotificationEvent | null;
  /** Update delivery JID for active sessions/queues when a LID→phone mapping changes. */
  handleJidAliasChanged?(conversationKey: string, newJid: string): void;
  /** Inject a repair turn into the control session for self-healing. */
  handleControlTurn?(reportId: string, payload: string): Promise<void>;
  /** Execute an internal agent command without routing through WhatsApp ingest. */
  handleAgentCommand?(request: AgentCommandRequest): Promise<AgentCommandResult>;
  /**
   * Provider-fallback observability (agent runtimes only). Returns the
   * currently effective provider, the epoch-ms expiry of an active fallback
   * window (`null` when running on the primary provider), and process-local
   * turn counters (reset on restart).
   */
  getFallbackState?(): {
    effectiveProvider: string;
    fallbackActiveUntil: number | null;
    fallbackReason?: string | null;
    fallbackModel?: string | null;
    fallbackResetAt?: number | null;
    fallbackRecoveryProbeRequired?: boolean;
    fallbackTurnsServed: number;
    fallbackTurnsEmpty: number;
    lastFallbackTurnAt: number | null;
    probeAttempts?: number;
    lastProbeAt?: number | null;
    fallbackActivations?: number;
    fallbackReverts?: number;
    fallbackWindowCostUsd?: number;
    primaryModelUsability?: unknown | null;
    turnCapability?: RuntimeTurnCapabilityHealth;
    activeFallbackEntry?: AgentFallbackEntry | null;
    fallbackChain?: Array<AgentFallbackEntry & { eligible: boolean | null }>;
    fallbackChainExhausted?: boolean;
    failedEntryCount?: number;
  };
  /** Admin override: force a fallback window of the given duration (or the default). */
  forceFallback?(durationMs?: number): { ok: true; activeUntil: number; clamped: boolean } | { ok: false; reason: string };
  /** Admin override: end any active fallback window immediately. Idempotent. */
  disableFallback?(): { ok: true };
  /**
   * #1753 rem-2: MCP tool-call liveness (agent runtimes only). The oldest
   * in-flight call's age and the pending count make an async-hung send path
   * (tool.handler() never resolving) visible in /health even when the event
   * loop itself is free — a case loop-lag sampling structurally cannot catch.
   */
  getMcpLivenessSnapshot?(): {
    pendingCount: number;
    oldestCallAgeMs: number | null;
    oldestCallTool: string | null;
  } | null;
  /** Process-local losses while persisting metadata-only tool evidence. */
  getToolDurabilityTelemetrySnapshot?(): ToolDurabilityTelemetrySnapshot | null;
}
