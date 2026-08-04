// ---------------------------------------------------------------------------
//  WhatSoup Console — Shared Type Definitions
// ---------------------------------------------------------------------------

export type Mode = 'passive' | 'chat' | 'agent';
export type Status = 'online' | 'degraded' | 'unreachable' | 'logged_out' | 'config_error' | 'unknown';
export type StatusConfidence = 'confirmed' | 'inferred' | 'ambiguous';

/**
 * Per-metric DB read availability (#1879). Mirrors the server's discriminator
 * (src/fleet/routes/lines.ts): `available` is a genuine read (which may
 * legitimately carry a zero/null value), `unavailable` is a failed/faulted
 * read that must be excluded from fleet totals rather than counted as a real
 * zero, and `not_applicable` is a structurally-absent metric (e.g. session
 * counts on a non-agent instance).
 */
export type MetricAvailability = 'available' | 'unavailable' | 'not_applicable';

/** One entry per DB-derived metric group enrichInstance can observe. */
export interface MetricAvailabilityMap {
  messageStats?: MetricAvailability;
  sessions?: MetricAvailability;
  chatCounts?: MetricAvailability;
  tokenStats?: MetricAvailability;
  lastActivity?: MetricAvailability;
}

export interface LineInstance {
  name: string;
  phone: string;
  mode: Mode;
  provider?: string;
  status: Status;
  statusConfidence?: StatusConfidence | null;
  statusReason?: string | null;
  statusEvidence?: string[];
  accessMode: string;
  healthPort: number;
  uptime: string;
  messagesTotal: number;
  health: {
    status: string;
    uptime_seconds: number;
    messages_total: number;
    // Matches the ONE /health emitter (src/core/health.ts): connection state
    // nests under whatsapp.connection, never top-level. See #1763 — the
    // CONNECTION card read a top-level `connection` no emitter ever produced.
    // `connected` is the emitter's composed transport-up signal
    // (`connectionState.connected && state === 'connected'`); it distinguishes
    // a degraded-but-connected line from a disconnected one (#1881). Optional
    // for non-Baileys transports (signal/imessage/twilio) that emit only the
    // generic `transport` block below; Baileys lines always carry it.
    whatsapp?: { connected?: boolean; connection: { state: string } };
    // Generic transport-health block: emitted by health.ts
    // alongside `whatsapp` so signal/imessage/twilio lines report through
    // the same shape. Consumers read this first with a `whatsapp` fallback.
    // `kind` is the line's TransportId; `selfId` replaces account_jid
    // (Signal UUID / AppleID aren't JIDs). Optional until the console
    // migration completes.
    transport?: {
      kind?: string;
      connected?: boolean;
      selfId?: string;
      connection?: { state?: string };
    };
    sqlite: { messages_total: number; schema_version: number };
    runtime?: {
      passive?: { unreadCount: number; lastActivityAt: string | null };
      chat?: {
        queueDepth: number;
        enrichmentUnprocessed: number;
        queue_admission?: {
          rejected_total: number;
          unowned_total: number;
        };
      };
      agent?: {
        activeSessions: number;
        lastSessionStatus: string | null;
        lastSessionStartedAt: string | null;
      };
    };
    instance?: {
      name: string;
      mode: Mode;
      accessMode: string;
      socketPath: string | null;
      provider?: string;
    };
  } | null;
  // Freshness seam (#1762 remediation 1, enrichInstance in src/fleet/routes/lines.ts):
  // when `health` was last genuinely replaced by a live poll, and whether the
  // poller is currently failing (in which case `health` may be carried
  // forward from that observation rather than reflecting the current instant).
  healthObservedAt?: string | null;
  stale?: boolean;
  heartbeat: ('up' | 'down' | 'slow')[];
  lastActive: string;
  error: string | null;
  unread?: number;
  queueDepth?: number;
  enrichmentUnprocessed?: number;
  activeSessions?: number;
  lastSessionStatus?: string | null;
  messagesToday?: number;
  messageStats?: {
    sent: number;
    received: number;
    images: number;
    audio: number;
    documents: number;
  };
  group?: string;
  config?: Record<string, unknown>;
  linkedStatus?: 'linked' | 'unlinked' | 'unknown';
  linkedStatusConfidence?: StatusConfidence | null;
  linkedStatusReason?: string | null;
  linkedStatusEvidence?: string[];
  totalSessions?: number;
  models?: {
    conversation?: string;
    fallback?: string;
    extraction?: string;
    validation?: string;
  } | null;
  sandboxPerChat?: boolean;
  chatCounts?: { chats: number; groups: number };
  tokenUsage?: { input: number; output: number };
  metricAvailability?: MetricAvailabilityMap;
}

export interface ChatItem {
  conversationKey: string;
  name: string;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  isGroup: boolean;
}

export interface Message {
  pk: number;
  conversationKey: string;
  senderName: string;
  senderJid: string;
  content: string | null;
  timestamp: string;
  fromMe: boolean;
  type: string;
  rawMessage?: string;
  modelUsed?: string | null;
}

export type MetricsRange = '24h' | '7d' | '30d';

export interface MessageVolumeBucket {
  bucket: string;
  inbound: number;
  outbound: number;
  media: number;
}

export interface TokenUsageBucket {
  bucket: string;
  input: number;
  output: number;
}

export interface SessionActivityBucket {
  bucket: string;
  active: number;
  started: number;
}

export interface FleetMetricsMeta {
  instancesQueried: number;
  instancesFailed: number;
  hasMessageData: boolean;
  hasTokenData: boolean;
  hasSessionData: boolean;
  providers: string[];
}

export interface LineMetrics {
  range: MetricsRange;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];
  sessionActivity: SessionActivityBucket[];
  tokenUsageByProvider: Record<string, TokenUsageBucket[]>;
  sessionActivityByProvider: Record<string, SessionActivityBucket[]>;
  activeHours: number[][];
  activeHoursByDate: { date: string; hours: number[] }[];
  hasMessageData: boolean;
  hasTokenData: boolean;
  hasSessionData: boolean;
  providers: string[];
}

export interface FleetMetrics {
  range: MetricsRange;
  meta: FleetMetricsMeta;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];
  sessionActivity: SessionActivityBucket[];
  tokenUsageByProvider: Record<string, TokenUsageBucket[]>;
  sessionActivityByProvider: Record<string, SessionActivityBucket[]>;
}

export interface AccessEntry {
  subjectType: 'phone' | 'group';
  subjectId: string;
  subjectName: string;
  status: 'allowed' | 'blocked' | 'pending' | 'seen';
  updatedAt: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  source: string;
  component?: string;
}

export type FeedDetail =
  // SSOT-TRACK (#2201, superseded from hand-mirror by #2892): the 'connection'
  // variant's `state` field tracks the canonical ConnectionLifecycleState union
  // declared once in src/transport/connection.ts (CONNECTION_LIFECYCLE_STATES).
  // Pre-#2892 this was a hand-mirror of feed.ts's own inline literal; #2892
  // moved feed.ts to derive its own (narrower, 3-value: connecting/connected/
  // disconnected — the only transitions its log-line parser emits today) subset
  // from that same canonical union via a compile-checked `satisfies` array, so
  // feed.ts's FeedDetail.state is no longer identical to this one — it's a
  // proper subset. This console copy deliberately stays at the FULL 6-value
  // domain (not narrowed to feed.ts's current subset) so a future emitter
  // widening feed.ts's subset doesn't require a console PR; see
  // tests/console/feed-detail-connection-state-type.test.ts, which asserts
  // equality against ConnectionLifecycleState directly (src/transport/connection.ts),
  // not against feed.ts. Not shared-imported because connection.ts is a
  // 2900+ line module with a heavy Baileys/config import graph, unlike the
  // light "leaf types" modules this file already shares across the
  // console/server boundary (e.g. src/core/mark-read-types.ts, re-exported below).
  | { type: 'connection'; statusCode?: number; reason?: string; reconnecting?: boolean; state?: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'cooldown' | 'shutting_down' }
  | { type: 'tool_error'; toolName: string; toolId?: string; error: string }
  | { type: 'tool_use'; toolName: string; toolId?: string }
  | { type: 'session'; action: string; sessionId?: string; chatJid?: string; reason?: string }
  | {
      type: 'health';
      status: string;
      previousStatus?: string;
      error?: string;
      confidence?: StatusConfidence;
      reason?: string;
      evidence?: string[];
    }
  | { type: 'import'; table?: string; count?: number; skipped?: boolean }
  | { type: 'message'; direction: 'inbound' | 'outbound'; chatJid?: string; messageId?: string; preview?: string; senderName?: string; contentType?: string; conversationKey?: string }
  | { type: 'generic' };

export interface FeedEvent {
  time: string;
  mode: Mode;
  text: string;
  isError?: boolean;
  instance?: string;
  provider?: string;
  component?: string;
  level?: 'info' | 'warn' | 'error';
  detail?: FeedDetail;
}

// ---------------------------------------------------------------------------
//  MCP Proxy Types
// ---------------------------------------------------------------------------

export interface ScheduledMessage {
  id: number;
  chatJid: string;
  chatName?: string;
  contentType: string;
  payload: Record<string, unknown>;
  scheduledAt: number;
  recurrence?: string;
  nextRunAt?: number;
  runCount: number;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  createdAt: number;
  sentAt?: number;
  error?: string;
  retryCount: number;
}

export interface GroupInfo {
  id: string;
  subject: string;
  participants: GroupParticipant[];
  creation?: number;
  desc?: string;
  owner?: string;
  announce?: boolean;
  locked?: boolean;
  ephemeralDuration?: number;
}

export interface GroupParticipant {
  id: string;
  admin?: 'admin' | 'superadmin';
}

export interface GroupDetail extends GroupInfo {
  inviteLink?: string;
  memberAddMode?: 'all_member_add' | 'admin_add';
  joinApprovalMode?: 'on' | 'off';
  pendingRequests?: { jid: string }[];
}

export interface ContactResult {
  jid: string;
  name?: string;
  notify?: string;
  number?: string;
}

// ---------------------------------------------------------------------------
//  Provider catalog + per-instance provider/key/fallback status
//  Mirrors GET /api/providers and GET /api/lines/:name/provider-status
//  (src/fleet/routes/providers.ts, src/fleet/routes/lines.ts).
// ---------------------------------------------------------------------------

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  type: 'cli' | 'api';
  needsApiKey: boolean;
  providerConfig: string[];
}

/** One provider slot (primary or fallback) in the provider-status response. */
/** Windowed per-sender throttle aggregate for one line (D-5) —
 *  `rate_limits` is per-SENDER chat throttling, not provider quota. */
export interface RateLimitsPayload {
  observedAt: string;
  /** False when the instance tables are absent (legacy DB) — the card hides. */
  supported: boolean;
  /** Effective limit the buckets were computed against. */
  limit: number;
  /** Which seam supplied limit/window: instance config.json or documented
   *  defaults. ENV overrides are fleet-invisible (declared, not hidden). */
  limitSource: 'config' | 'default';
  windowMs: number;
  throttled: number;
  nearLimit: number;
  topSenders: Array<{ senderJid: string; count: number }>;
  windowedResponses: number;
  windowedAttempts: number;
  /** max(0, attempts − responses) — retry/token-storm waste (#1864 class). */
  excessAttempts: number;
  /** Present and true only on a fleet read failure — render "unavailable",
   *  never a fake-zero calm state (fail-closed, PDR-3). */
  readError?: boolean;
}

export interface ProviderSlotStatus {
  provider: string | null;
  model: string | null;
  /** true = key set, false = no key, null = native auth (no key required). */
  keyPresent: boolean | null;
}

export interface ProviderStatus {
  primary: ProviderSlotStatus;
  fallback: ProviderSlotStatus & {
    /** Whether the runtime is currently serving on its fallback provider. */
    active: boolean;
    /** Epoch ms the fallback window reverts, or null when inactive/unset. */
    activeUntil: number | null;
    /** Provider currently serving turns according to the health snapshot. */
    effectiveProvider: string | null;
    /** Process-local count of turns served during the current fallback window. */
    turnsServed: number | null;
    /** Process-local count of fallback turns with no visible output. */
    turnsEmpty: number | null;
    /** Consecutive failed extension probes in the current stall episode; null when not yet exposed. */
    probeAttempts: number | null;
    /** Epoch ms of the most recent fallback-served turn, or null when absent. */
    lastFallbackTurnAt: number | null;
    /** Selected fallback entry while a runtime window is active. */
    activeEntry: { provider: string; model: string | null } | null;
    /** Ordered fallback chain; eligible is null when only static config is available. */
    chain: Array<{ provider: string; model: string | null; eligible: boolean | null }>;
  };
  signal?: {
    status: 'online' | 'degraded' | 'unreachable' | 'logged_out' | null;
    confidence: StatusConfidence | null;
    reason: string | null;
    evidence: string[];
  };
  /** True only when the latest poll reached the line's health endpoint. */
  lineReachable: boolean;
}

/** Checkpoint browser (LineDetail › Checkpoints tab) — server shape of
 *  GET /api/lines/:name/checkpoints (src/fleet/routes/checkpoints.ts). */
export interface CheckpointRow {
  conversationKey: string;
  sessionId: string | null;
  sessionStatus: string;
  checkpointVersion: number;
  claudePid: number | null;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
  completedScope: string | null;
  completedDeliveryJid: string | null;
  completedLogicalTurnId: string | null;
  /** Server-computed with the durability engine's exact resume filter. */
  resumable: boolean;
}

/** One checkpoint row joined with live process state (terminal stage A). */
export interface LiveSession {
  conversationKey: string;
  sessionStatus: string;
  resumable: boolean;
  claudePid: number | null;
  /** null when the row has no pid; otherwise whether the pid is alive. */
  pidAlive: boolean | null;
  pidState: string | null;
  pidEtimeSeconds: number | null;
  /** 'resumable-but-pid-dead' (claims live, process gone) or
   *  'pid-alive-after-end' (ended row, process lives — the #1861 stale-
   *  retention class). */
  anomaly: 'resumable-but-pid-dead' | 'pid-alive-after-end' | null;
}

export interface LiveSessionsPayload {
  observedAt: string;
  sessions: LiveSession[];
  anomalyCount: number;
  /** Present and true only on a probe failure — never fabricated liveness. */
  probeError?: boolean;
  readError?: boolean;
}

export interface CheckpointsPayload {
  observedAt: string;
  checkpoints: CheckpointRow[];
  /** Present and true only when the fleet could not read the instance DB —
   *  render "unavailable", never a fake empty state (fail-closed, PDR-3). */
  readError?: boolean;
}

/** One question inside a pending decision poll (D-4 approval queue). */
export interface ApprovalQuestion {
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** A pending agent decision awaiting a human answer (D-4). */
export interface ApprovalEntry {
  mapKey: string;
  chatJid: string;
  mode: 'poll' | 'textFallback';
  source: 'askuser' | 'send_poll';
  questions: ApprovalQuestion[];
  currentQuestionIndex: number;
  answersCollected: Record<number, string>;
  createdAt: number;
  timeoutMs: number;
  hardClosesAt: number | null;
}

export interface ApprovalsPayload {
  observedAt: string;
  supported: boolean;
  approvals: ApprovalEntry[];
  /** Rows whose stored payload failed to parse — fail-visible. */
  parseErrors: number;
  /** Present and true only on a fleet read failure — render "unavailable",
   *  never a fake-empty queue (fail-closed, PDR-3). */
  readError?: boolean;
}

/**
 * Mark-read remote receipt (#2550). Shared live from the backend's leaf
 * types module (not `src/core/mark-read.ts` itself, which pulls in the
 * database/connection graph) so a future backend state added to the union
 * cannot silently vanish at this boundary — it fails the console's
 * exhaustiveness check at compile time instead.
 */
export type { MarkReadRemoteStatus, MarkConversationReadResult } from '../../src/core/mark-read-types.ts';
