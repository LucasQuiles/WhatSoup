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
    // a degraded-but-connected line from a disconnected one (#1881).
    whatsapp: { connected?: boolean; connection: { state: string } };
    sqlite: { messages_total: number; schema_version: number };
    runtime?: {
      passive?: { unreadCount: number; lastActivityAt: string | null };
      chat?: { queueDepth: number; enrichmentUnprocessed: number };
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
  | { type: 'connection'; statusCode?: number; reason?: string; reconnecting?: boolean; state?: 'connecting' | 'connected' | 'disconnected' }
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
