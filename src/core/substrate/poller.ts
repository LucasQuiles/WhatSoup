// src/core/substrate/poller.ts
//
// Substrate slice-3 trigger poller. Drains `bead_triggers.next_fire_at` on
// an interval, runs per-kind executors, writes `trigger_runs`, dispatches
// notifications to the trigger's `report_chat_jid`, and handles
// `terminal_at` expiry.
//
// Scope (per maintainer scoping decision, 2026-05-19; extended F2 Slice A
// 2026-06-20):
//   - poll.sqlite     — workhorse kind for personal-line watches
//   - poll.pinecone   — similarity search over the bot's own memory index
//                       (reuses the knowledge_search client + index allowlist)
//   - poll.file       — file existence / mtime / content-hash watch, behind a
//                       fail-closed allowed-root path policy (deny-all default)
//   - poll.url         — HTTP(S) change-detection watch (F2 Slice B), GATED
//                       default-OFF behind config.advanced.enableUrlWatch.
//                       Reuses the link-preview SSRF stack (fetchUrlGuarded),
//                       https-only + default-port-only + fail-CLOSED on a
//                       blocked host. Fires on a body/selector/header hash diff.
//   - schedule.cron   — fires on cron expression
//   - schedule.at_time — one-shot at fire_at, expires after
//   - terminal_at expiry — sets status='expired', fires on_terminal action
//
// poll.email is recognised but not yet executed (deferred — no Gmail/M365
// client exists); the poller records a noop with reason 'not_implemented' and
// bumps `next_fire_at` by the 1h cooldown so the row does not hot-loop.
// event.message is a RESERVED SCAFFOLD, not yet executed: a created row is
// persisted with next_fire_at=NULL (computeNextFireAt returns NULL for this
// kind) so dueTriggers never selects it — the poller does not poll or churn
// it; it only TTL-expires via the kind-agnostic terminal_at sweep. A legacy
// row that somehow has a non-null next_fire_at fails CLOSED here
// (errorKind 'event_message_not_polled') and is not rescheduled. It is
// event-driven and pending a future ingest-path integration (design exists),
// not the interval poller. poll.shell was REMOVED FROM CREATION (dropped from
// the create_watch enum so creation fails via Zod) but RETAINED INTERNALLY in
// TriggerKind/ShellSpec/SPEC_REGISTRY for legacy fail-closed handling — a
// legacy persisted row fails CLOSED here with errorKind 'shell_watch_removed'
// rather than crashing.

import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { basename, resolve, sep } from 'node:path';
import { realpathSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { nowUnixSec } from './time.ts';
import {
  dueTriggers, validateTriggerSpec, isSafeSqliteSql,
  countPastDueTriggers, DEFAULT_TRIGGER_PAST_DUE_GRACE_SEC,
} from './triggers.ts';
import { TERMINAL, countOverdueProposals } from './beads.ts';
import { writeBeadEvent } from './events.ts';
import { nextCronRun } from '../cron.ts';
import type { BeadStatus, TriggerKind, TriggerRow } from './types.ts';
import type { Messenger } from '../types.ts';
import { createChildLogger } from '../../logger.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { fetchUrlGuarded, SsrfBlockedError, type GuardedFetchResult } from '../../lib/ssrf-fetch.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../lib/emit-alert.ts';

const log = createChildLogger('substrate.trigger-poller');

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
/**
 * Hard cap on rows a single poll.sqlite execution may materialize (QR-026).
 * `query_only` bounds writes but not CPU/heap; a read-only recursive CTE passes
 * `isSafeSqliteSql` and would otherwise let `.all()` materialize unboundedly,
 * OOM-crashing / freezing the synchronous DatabaseSync (whole-process DoS). We
 * iterate and fail past this cap. NOTE: node:sqlite exposes no interrupt/step
 * limit and DatabaseSync blocks the event loop, so a CPU-spin yielding FEW rows
 * is NOT bounded by this — full containment needs out-of-process execution.
 */
export const MAX_SQLITE_ROWS = 10_000;
/** Cooldown applied when a kind is not yet implemented — avoids tight loops. */
const NOT_IMPLEMENTED_COOLDOWN_SEC = 3_600;
/** Cooldown applied after a transient failure so the poller does not spin. */
const FAILED_RETRY_COOLDOWN_SEC = 60;
/** Auto-pause a trigger after this many consecutive failed runs. */
const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * #1745 — auto-RETIRE a trigger after this many consecutive notification sends
 * rejected with a PERMANENT per-target authz error. Deliberately smaller than
 * MAX_CONSECUTIVE_FAILURES: a forbidden target (the bot was removed from the
 * group) never self-heals by retrying the SAME chat, so every further fire is
 * guaranteed-undeliverable and pure waste — the days-long incident loop.
 */
const MAX_CONSECUTIVE_FORBIDDEN_REJECTS = 3;

/**
 * #1745 — classify a notification-send rejection as a PERMANENT per-target
 * authz reject (the WhatsApp server refused because the bot is not a member
 * of / is forbidden from the target chat, e.g. removed from the group). Unlike
 * transient failures (timeout, connection closed, rate limit) this NEVER
 * recovers by retrying the same target, so it must short-circuit the producer
 * rather than loop forever.
 *
 * Grounded in historical incident bytes recorded before structured outbound
 * evidence: 167 quarantined rows contained the raw rejection `forbidden`.
 * Current durability stores only the bounded failure envelope, while this
 * producer-side classifier still inspects the live thrown error. The
 * `output.statusCode === 403` fallback also catches a Boom-wrapped reject whose
 * message is opaque.
 *
 * 401/`unauthorized` is deliberately EXCLUDED: it is a session/auth condition
 * (a re-pair heals it), NOT a per-target verdict — treating it as terminal
 * would wrongly retire a healthy producer during a transient auth blip.
 */
export function isForbiddenTargetReject(err: unknown): boolean {
  const raw = errorMessage(err).toLowerCase();
  if (/forbidden|\b403\b|not[- ]a[- ]participant|not a group member|no longer (a )?(member|participant)|not in (the )?group/.test(raw)) {
    return true;
  }
  // Boom-shaped rejects carry the HTTP-ish code on output.statusCode; some
  // wrappers surface it top-level. 403 == forbidden; 401 is intentionally NOT
  // matched here (session auth, transient).
  const candidate = err as { output?: { statusCode?: unknown }; statusCode?: unknown } | null;
  const code = typeof candidate?.output?.statusCode === 'number'
    ? candidate.output.statusCode
    : typeof candidate?.statusCode === 'number'
      ? candidate.statusCode
      : null;
  return code === 403;
}
/**
 * Default backlog-alert threshold for #1773 rem-3 (overridden by
 * config.memory.sweep.overdueProposalAlertThreshold in production). Alerts
 * once the count of status='proposed' beads past review_by_at exceeds this
 * many rows — see checkOverdueProposalBacklog.
 */
const DEFAULT_OVERDUE_PROPOSAL_ALERT_THRESHOLD = 10;
/** Minimum seconds between WhatsApp notifications per trigger. */
const NOTIFICATION_THROTTLE_MIN_INTERVAL_SEC = 300;
/**
 * Max bytes hashed for a `poll.file` content_hash read. Bounds the blast
 * radius of a confused-deputy spec pointed at a huge file (the watch reads
 * host FS in the MAIN process, outside the agent sandbox). 16 MiB is far
 * above any realistic watched config/log file; larger reads stop early and
 * the hash covers only the prefix (still a stable change-detector).
 */
const FILE_HASH_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Pseudo-filesystem prefixes that are never legitimate watch targets even if
 * an allowed root nominally contains them. Reading these can hang, leak kernel
 * state, or block on device I/O. Rejected fail-closed regardless of allowlist.
 */
const DENIED_PATH_PREFIXES = ['/proc', '/dev', '/sys'];

/**
 * Ports a `poll.url` watch may target. https default (443) and the bare form
 * only — any explicit non-default port is rejected fail-closed (a confused
 * deputy could otherwise reach an internal service on a high port whose host
 * happens to resolve public). Mirrors the SSRF posture of the link-preview
 * stack but tighter (the preview path soft-degrades; the watch errors).
 */
const URL_WATCH_ALLOWED_PORTS = new Set(['', '443']);
/**
 * Max bytes fetched for a `poll.url` watch. Bounds the blast radius of a
 * confused-deputy spec pointed at a huge response. Reusing the same 5 MiB cap
 * the link-preview path uses (readBodyCapped truncates at this prefix; any
 * prefix change still flips the change-detection hash).
 */
const URL_WATCH_MAX_BYTES = 5_000_000;
/** Header subset hashed for hash_mode:'headers' — stable change-detection keys. */
const URL_WATCH_HASH_HEADERS = ['etag', 'last-modified', 'content-length', 'content-type'];

/** A single Pinecone match — only the score is consumed (no record body). */
export interface PineconeMatch {
  score: number;
}

/** Spec passed to an injected Pinecone search function. */
export interface PineconeSearchArgs {
  index: string;
  namespace: string;
  query: string;
  topK: number;
}

/**
 * Injected Pinecone access path for `poll.pinecone`. Production wires this to
 * the same client + project guard used by `knowledge_search`; tests inject a
 * stub. Returning only `{ matches: [{ score }] }` keeps record bodies out of
 * the poller entirely (redaction-by-construction).
 */
export type PineconeSearchFn = (args: PineconeSearchArgs) => Promise<{ matches: PineconeMatch[] }>;

/**
 * Injected guarded-fetch path for `poll.url`. Production wires this to
 * `fetchUrlGuarded` from the link-preview SSRF stack (per-hop resolved-IP
 * revalidation, body-cap, timeout); tests inject a stub. Throwing
 * `SsrfBlockedError` maps to a fail-closed `ssrf_blocked` outcome.
 */
export type UrlFetchFn = (url: string, opts: { maxBytes: number }) => Promise<GuardedFetchResult>;

/**
 * Context handed to the agent-job dispatcher when a schedule.* trigger whose
 * linked bead is an `agent_job` fires. The dispatcher (wired only into the
 * agent runtime — the poller itself cannot run turns) enqueues the prompt as a
 * real agent turn and returns synchronously whether the turn was accepted.
 */
export interface AgentJobContext {
  beadId: number;
  triggerId: number;
  /** agent_job bead body — the prompt to run as a turn. */
  prompt: string;
  /** agent_job bead title — for logging / turn labelling. */
  title: string;
  /** Where the job reports — becomes the synthetic turn's chat. */
  reportChatJid: string;
}

/** Result of an agent-job dispatch attempt. `dispatched:false` fails CLOSED. */
export interface AgentJobDispatchResult {
  dispatched: boolean;
  /** Optional detail (queue depth, rejection reason) recorded on the run. */
  detail?: string;
}

/**
 * Injected agent-job dispatcher. Production wires this to the AgentRuntime
 * (enqueues a synthetic turn). Instances with no agent runtime (the passive
 * primary-line) leave it UNSET, so an agent_job-linked schedule fails CLOSED
 * with `agent_job_dispatcher_unavailable` rather than silently no-op'ing.
 * Synchronous by design: it only ACCEPTS the turn for async processing and
 * must not block the poller tick on the whole turn.
 */
export type AgentJobDispatchFn = (ctx: AgentJobContext) => AgentJobDispatchResult;

export interface TriggerPollerOptions {
  /** How often to call dueTriggers. Default 30s. */
  intervalMs?: number;
  /** Max triggers fetched per tick. Default 50. */
  batchSize?: number;
  /** Injectable clock for tests. Returns unix seconds. */
  now?: () => number;
  /** Injectable timers for tests. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /** Auto-pause threshold for consecutive failed runs. Default 5. */
  maxConsecutiveFailures?: number;
  /**
   * #1745 — auto-RETIRE threshold for consecutive notification sends rejected
   * with a permanent per-target authz error (forbidden/403). Default 3. Smaller
   * than maxConsecutiveFailures because a forbidden target never self-heals.
   */
  maxConsecutiveForbiddenRejects?: number;
  /** Minimum seconds between dispatches per trigger. Default 300 (5 min). */
  notificationThrottleMinIntervalSec?: number;
  /**
   * Allowlist of Pinecone index names a `poll.pinecone` watch may query.
   * Empty/unset = deny-all (fail-closed). Production passes
   * `config.memory.pinecone.allowedIndexes`.
   */
  pineconeAllowedIndexes?: string[];
  /**
   * Injected Pinecone search path for `poll.pinecone`. When unset, the
   * executor fails closed with `pinecone_unavailable` (never silently noops).
   */
  pineconeSearch?: PineconeSearchFn;
  /**
   * Allowlist of filesystem roots a `poll.file` watch may resolve under.
   * Empty/unset = deny-all (fail-closed) — this INVERTS the agent-sandbox
   * hook's fail-open `allowedPaths.length===0 ⇒ allow`, because the poller
   * runs unsandboxed in the main process.
   */
  fileWatchAllowedRoots?: string[];
  /**
   * Gate for `poll.url` watches (F2 Slice B). Default OFF — when false the
   * executor fails closed with `url_watch_disabled` even for a persisted row
   * (defense-in-depth alongside the create_watch creation-throw). Production
   * passes `config.advanced.enableUrlWatch`.
   */
  enableUrlWatch?: boolean;
  /**
   * Injected guarded-fetch path for `poll.url`. When unset, defaults to the
   * shared `fetchUrlGuarded` SSRF helper. Tests inject a stub to avoid network.
   */
  urlFetch?: UrlFetchFn;
  /**
   * Injected agent-job dispatcher for schedule.* triggers whose linked bead is
   * an `agent_job`. When UNSET (e.g. passive instances with no agent runtime),
   * such a fire fails CLOSED (`agent_job_dispatcher_unavailable`) instead of
   * posting a bare "cron tick fired" notification that never runs the prompt.
   */
  agentJobDispatch?: AgentJobDispatchFn;
  /**
   * Instance name (config.botName) used to attribute the #1773 rem-3 backlog
   * alert via emitAlertChecked. When UNSET the backlog check is skipped
   * entirely (fail-safe no-op) — an alert with no attributable instance
   * cannot be routed, so it must not attempt to fire at all. This also keeps
   * tests that construct a TriggerPoller without an instance name from ever
   * touching the alert channel.
   */
  instance?: string;
  /**
   * Threshold for the #1773 rem-3 backlog alert: emitted once the count of
   * status='proposed' beads past review_by_at exceeds this many rows.
   * Production passes config.memory.sweep.overdueProposalAlertThreshold.
   */
  overdueProposalAlertThreshold?: number;
  /**
   * #1765 — grace window (seconds) before an active, never-fired trigger whose
   * next_fire_at is in the past is reported as a liveness violation. Default 24h
   * (86400s). Only consulted when `instance` is set (same gate as the backlog
   * alert). Tests inject a small value to exercise the watchdog deterministically.
   */
  triggerPastDueGraceSeconds?: number;
}

interface SqliteSpec {
  sql: string;
  binds?: unknown[] | Record<string, unknown>;
  fire_when: 'rows_returned' | 'rowcount_changed';
}

interface PineconeTriggerSpec {
  index: string;
  namespace: string;
  query: string;
  top_k?: number;
  threshold?: number;
}

interface FileTriggerSpec {
  path: string;
  watch: 'exists' | 'mtime' | 'content_hash';
}

interface UrlTriggerSpec {
  url: string;
  selector?: string;
  hash_mode: 'text' | 'selector' | 'headers';
}

/** Default top_k when a poll.pinecone spec omits it. */
const PINECONE_DEFAULT_TOP_K = 5;

/**
 * Enumerated `outputJson.reason` codes emitted by the trigger executors. Single source of truth to
 * diff against docs/runbooks/personal-line-watch.md. Not all outputJson shapes carry a reason —
 * only the fail-closed / not-implemented branches do.
 */
const TRIGGER_REASONS = [
  'shell_watch_removed',
  'event_message_not_polled',
  'not_implemented',
  'unsafe_sql',
  'index_not_allowed',
  'pinecone_unavailable',
  'path_not_allowed',
  'url_watch_disabled',
  'ssrf_blocked',
  'fetch_error',
] as const;
type TriggerReason = (typeof TRIGGER_REASONS)[number];

interface ExecuteOutcome {
  status: 'ok' | 'noop' | 'failed';
  fired: boolean;
  outputSummary: string;
  outputJson: Record<string, unknown>;
  errorKind?: string;
  errorMessage?: string;
}

interface PostCommitActions {
  pauseNotificationFailureCount?: number;
}

/**
 * Outcome of a post-commit notification dispatch. `failed` is true ONLY when a
 * send was attempted and the messenger threw — it distinguishes a fired-but-
 * undelivered run from one that was never dispatched (throttled / not eligible,
 * which are gated out before dispatchNotification is called). A successful send
 * that returns no waMessageId is `{ waId: null, failed: false }` — still
 * delivered, just without a receipt id, so it is NOT a dispatch failure.
 */
interface NotificationDispatch {
  waId: string | null;
  failed: boolean;
  /**
   * #1745 — set when `failed` is true AND the send threw a PERMANENT per-target
   * authz reject (forbidden/403). Distinguishes a retry-forever transport blip
   * from a target that will never accept a send (bot removed from the group).
   */
  terminalReject: boolean;
}

export class TriggerPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly db: DatabaseSync;
  private readonly messenger: Messenger;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly nowFn: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly maxConsecutiveFailures: number;
  private readonly maxConsecutiveForbiddenRejects: number;
  private readonly notificationThrottleMinIntervalSec: number;
  private readonly pineconeAllowedIndexes: ReadonlySet<string>;
  private readonly pineconeSearch: PineconeSearchFn | null;
  private readonly fileWatchAllowedRoots: readonly string[];
  private readonly enableUrlWatch: boolean;
  private readonly urlFetch: UrlFetchFn;
  private readonly agentJobDispatch: AgentJobDispatchFn | null;
  private readonly instance: string | null;
  private readonly overdueProposalAlertThreshold: number;
  /**
   * State-transition guard for the #1773 rem-3 backlog alert (mirrors
   * ConnectionManager.loggedOutAlertEmitted): fire once when the backlog
   * crosses the threshold, clear once it drains back at/under it — never
   * re-alert every tick while the condition persists.
   */
  private overdueProposalAlertEmitted = false;
  private readonly triggerPastDueGraceSeconds: number;
  /**
   * State-transition guard for the #1765 past-due liveness alert (same latch
   * shape as overdueProposalAlertEmitted): fire once when an active never-fired
   * trigger crosses the grace window, clear once none remain — never re-alert
   * every tick while the firing path stays down.
   */
  private triggerPastDueAlertEmitted = false;
  public lastRunAt: string | null = null;

  /**
   * #2292 L15 — constant-SQL statements hoisted to instance fields, prepared
   * once at construction rather than every call. `executeSqlite`'s
   * operator-stored `spec.sql` (line ~922) is NOT here — that SQL is dynamic
   * per-trigger and must stay prepared per-call.
   */
  private readonly stmtOverdueTerminalTriggers: StatementSync;
  private readonly stmtLastDeliveredRun: StatementSync;
  private readonly stmtLookupBead: StatementSync;
  private readonly stmtLastRowCountRun: StatementSync;
  private readonly stmtLastHashRun: StatementSync;
  private readonly stmtLastUrlHashRun: StatementSync;
  private readonly stmtLastScalarRun: StatementSync;
  private readonly stmtInsertRun: StatementSync;
  private readonly stmtFinishRun: StatementSync;
  private readonly stmtRecordDeliveredWaMessageId: StatementSync;
  private readonly stmtRecordNotifyDispatchFailed: StatementSync;
  private readonly stmtRecordNotifyForbiddenTarget: StatementSync;
  private readonly stmtRecentErrorKinds: StatementSync;
  private readonly stmtRetireTriggerOnForbiddenTarget: StatementSync;
  private readonly stmtScheduleNextFire: StatementSync;
  private readonly stmtRecentRunStatuses: StatementSync;
  private readonly stmtMarkPausedOnFailures: StatementSync;
  private readonly stmtMarkExpiredTrigger: StatementSync;
  private readonly stmtInsertExpiryRun: StatementSync;
  private readonly stmtLookupBeadStatus: StatementSync;
  private readonly stmtReopenBead: StatementSync;

  constructor(db: DatabaseSync, messenger: Messenger, opts: TriggerPollerOptions = {}) {
    this.db = db;
    this.messenger = messenger;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.nowFn = opts.now ?? nowUnixSec;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
    this.maxConsecutiveForbiddenRejects = opts.maxConsecutiveForbiddenRejects ?? MAX_CONSECUTIVE_FORBIDDEN_REJECTS;
    this.notificationThrottleMinIntervalSec = opts.notificationThrottleMinIntervalSec ?? NOTIFICATION_THROTTLE_MIN_INTERVAL_SEC;
    this.pineconeAllowedIndexes = new Set(opts.pineconeAllowedIndexes ?? []);
    this.pineconeSearch = opts.pineconeSearch ?? null;
    // Canonicalise allowed roots once at construction. We realpath() each root
    // so the exec-time symlink-escape recheck (which realpaths the TARGET)
    // compares like-with-like — otherwise platform symlinks such as macOS
    // /var -> /private/var would make every legitimate target appear to escape.
    this.fileWatchAllowedRoots = (opts.fileWatchAllowedRoots ?? []).map(canonicalizeAllowedRoot);
    this.enableUrlWatch = opts.enableUrlWatch ?? false;
    this.urlFetch = opts.urlFetch ?? fetchUrlGuarded;
    this.agentJobDispatch = opts.agentJobDispatch ?? null;
    this.instance = opts.instance ?? null;
    this.overdueProposalAlertThreshold = opts.overdueProposalAlertThreshold ?? DEFAULT_OVERDUE_PROPOSAL_ALERT_THRESHOLD;
    this.triggerPastDueGraceSeconds = opts.triggerPastDueGraceSeconds ?? DEFAULT_TRIGGER_PAST_DUE_GRACE_SEC;

    // #2292 L15 — prepare constant SQL once here rather than per-call/per-tick.
    // SQL text below is byte-identical to what each call site used to inline.
    this.stmtOverdueTerminalTriggers = this.db.prepare(
      `SELECT * FROM bead_triggers
       WHERE status = 'active' AND terminal_at IS NOT NULL AND terminal_at <= ?
       LIMIT ?`,
    );
    this.stmtLastDeliveredRun = this.db.prepare(
      `SELECT started_at FROM trigger_runs
       WHERE trigger_id = ? AND status = 'ok'
         AND json_valid(output_json)
         AND json_extract(output_json, '$.deliveredWaMessageId') IS NOT NULL
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    );
    this.stmtLookupBead = this.db.prepare(
      `SELECT kind, title, body FROM beads WHERE id = ?`,
    );
    this.stmtLastRowCountRun = this.db.prepare(
      `SELECT output_json FROM trigger_runs
       WHERE trigger_id = ? AND status IN ('ok','noop')
       ORDER BY started_at DESC
       LIMIT 1`,
    );
    this.stmtLastHashRun = this.db.prepare(
      `SELECT output_json FROM trigger_runs
       WHERE trigger_id = ? AND status IN ('ok','noop')
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    );
    this.stmtLastUrlHashRun = this.db.prepare(
      `SELECT output_json FROM trigger_runs
       WHERE trigger_id = ? AND status IN ('ok','noop')
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    );
    this.stmtLastScalarRun = this.db.prepare(
      `SELECT output_json FROM trigger_runs
       WHERE trigger_id = ? AND status IN ('ok','noop')
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    );
    this.stmtInsertRun = this.db.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, attempt, metadata_json
       ) VALUES (?, ?, 'running', ?, 1, '{}')`,
    );
    this.stmtFinishRun = this.db.prepare(
      `UPDATE trigger_runs
       SET status = ?, finished_at = ?, duration_ms = ?,
           output_summary = ?, output_json = ?,
           error_kind = ?, error_message = ?
       WHERE id = ?`,
    );
    this.stmtRecordDeliveredWaMessageId = this.db.prepare(
      `UPDATE trigger_runs
       SET output_json = json_set(COALESCE(output_json, '{}'), '$.deliveredWaMessageId', ?)
       WHERE id = ?`,
    );
    this.stmtRecordNotifyDispatchFailed = this.db.prepare(
      `UPDATE trigger_runs SET error_kind = 'notify_dispatch_failed'
       WHERE id = ? AND error_kind IS NULL`,
    );
    this.stmtRecordNotifyForbiddenTarget = this.db.prepare(
      `UPDATE trigger_runs SET error_kind = 'notify_forbidden_target'
       WHERE id = ? AND error_kind IS NULL`,
    );
    this.stmtRecentErrorKinds = this.db.prepare(
      `SELECT error_kind FROM trigger_runs
       WHERE trigger_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    );
    this.stmtRetireTriggerOnForbiddenTarget = this.db.prepare(
      `UPDATE bead_triggers
       SET status = 'paused', next_fire_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    );
    this.stmtScheduleNextFire = this.db.prepare(
      `UPDATE bead_triggers
       SET next_fire_at = ?, last_fire_at = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.stmtRecentRunStatuses = this.db.prepare(
      `SELECT status FROM trigger_runs
       WHERE trigger_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    );
    this.stmtMarkPausedOnFailures = this.db.prepare(
      `UPDATE bead_triggers
       SET status = 'paused', next_fire_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    this.stmtMarkExpiredTrigger = this.db.prepare(
      `UPDATE bead_triggers
       SET status = 'expired', next_fire_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    this.stmtInsertExpiryRun = this.db.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'terminal_fired', ?, ?, 0, ?, ?, 1, '{}')`,
    );
    this.stmtLookupBeadStatus = this.db.prepare(
      `SELECT status FROM beads WHERE id = ?`,
    );
    this.stmtReopenBead = this.db.prepare(
      `UPDATE beads
       SET status = 'active', completed_at = NULL, cancelled_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
  }

  start(): void {
    if (this.timer !== null) {
      log.warn(
        { intervalMs: this.intervalMs, batchSize: this.batchSize },
        'TriggerPoller.start() called while already running',
      );
      return;
    }
    this.stopped = false;
    log.info({ intervalMs: this.intervalMs, batchSize: this.batchSize }, 'trigger poller starting');
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
      log.info({ intervalMs: this.intervalMs }, 'trigger poller stopped');
    }
  }

  /**
   * Run one cycle synchronously. Returns the number of triggers processed
   * (sum of expirations + dispatched runs). Public for tests; production
   * code goes through start()/tick().
   */
  async tickOnce(): Promise<number> {
    const now = this.nowFn();
    let processed = 0;
    // 1. Expiry sweep — dueTriggers filters out triggers past terminal_at,
    //    so without this sweep they would stay status='active' forever.
    const overdue = this.stmtOverdueTerminalTriggers
      .all(now, this.batchSize) as unknown as TriggerRow[];
    for (const t of overdue) {
      try {
        this.expireTrigger(t, now);
        processed++;
      } catch (err) {
        log.error({ err, triggerId: t.id }, 'trigger expiry failed unexpectedly');
      }
    }
    // 2. Due triggers — normal poll/schedule execution path.
    const due = dueTriggers(this.db, now, this.batchSize);
    for (const t of due) {
      try {
        await this.processTrigger(t, now);
        processed++;
      } catch (err) {
        log.error(
          { err, triggerId: t.id, kind: t.kind },
          'trigger run failed unexpectedly',
        );
      }
    }
    // 3. Backlog-growth alert (#1773 rem-3). Isolated in its own try/catch so
    //    a count-query failure can never disrupt trigger draining above —
    //    tickOnce's primary job is dueTriggers/expiry, not this alert.
    try {
      this.checkOverdueProposalBacklog(now);
    } catch (err) {
      log.error({ err }, 'overdue-proposal backlog check failed unexpectedly');
    }
    // 4. Liveness watchdog (#1765). Runs AFTER the due loop, which drains and
    //    stamps every trigger it processes — so a non-zero count here means the
    //    firing path did NOT drain the row. Isolated in its own try/catch for
    //    the same reason as the backlog check: a count-query fault must never
    //    disrupt trigger draining above.
    try {
      this.checkPastDueTriggers(now);
    } catch (err) {
      log.error({ err }, 'past-due trigger liveness check failed unexpectedly');
    }
    this.lastRunAt = new Date(now * 1000).toISOString();
    return processed;
  }

  /**
   * #1773 rem-3: alert when the count of status='proposed' beads past
   * review_by_at exceeds overdueProposalAlertThreshold. State-transition
   * guarded (fires once, clears once resolved) via
   * overdueProposalAlertEmitted, mirroring ConnectionManager's
   * loggedOutAlertEmitted pattern rather than re-alerting every tick.
   * No-ops when `instance` is unset — an alert with no attributable instance
   * name cannot be routed through emitAlertChecked.
   */
  private checkOverdueProposalBacklog(now: number): void {
    if (!this.instance) return;
    const count = countOverdueProposals(this.db, now);
    const over = count > this.overdueProposalAlertThreshold;
    if (over && !this.overdueProposalAlertEmitted) {
      this.overdueProposalAlertEmitted = emitAlertChecked(
        this.instance,
        'bead_proposal_backlog',
        `whatsoup@${this.instance} has ${count} bead proposals past review_by_at (threshold ${this.overdueProposalAlertThreshold})`,
        [
          `overdueCount=${count}`,
          `threshold=${this.overdueProposalAlertThreshold}`,
          `checkedAt=${new Date(now * 1000).toISOString()}`,
          'ref: #1773 — review_by_at was written but never read; use list_beads(review_overdue:true) to inspect, approve_proposal/reject_proposal to dispose.',
        ].join('\n'),
        'warning',
      );
    } else if (!over && this.overdueProposalAlertEmitted) {
      clearAlertSourceChecked(
        this.instance,
        'bead_proposal_backlog',
        `overdueCount=${count} <= threshold=${this.overdueProposalAlertThreshold}`,
      );
      this.overdueProposalAlertEmitted = false;
    }
  }

  /**
   * #1765 liveness watchdog: alert when any active trigger is >grace past its
   * next_fire_at yet has never fired (last_fire_at IS NULL) — nothing fired and,
   * without this, nothing alerts. A healthy poller drains such a row within one
   * tick, so a non-zero count means the firing path is down (paused poller,
   * clock skew, or a unit bug). State-transition guarded (fire once, clear once
   * resolved) via triggerPastDueAlertEmitted, mirroring
   * checkOverdueProposalBacklog. No-ops when `instance` is unset — an alert with
   * no attributable instance name cannot be routed through emitAlertChecked.
   */
  private checkPastDueTriggers(now: number): void {
    if (!this.instance) return;
    const count = countPastDueTriggers(this.db, now, this.triggerPastDueGraceSeconds);
    const over = count > 0;
    if (over && !this.triggerPastDueAlertEmitted) {
      this.triggerPastDueAlertEmitted = emitAlertChecked(
        this.instance,
        'trigger_past_due',
        `whatsoup@${this.instance} has ${count} active trigger(s) past due by more than ${this.triggerPastDueGraceSeconds}s with zero runs — the firing path may be down`,
        [
          `pastDueCount=${count}`,
          `graceSeconds=${this.triggerPastDueGraceSeconds}`,
          `checkedAt=${new Date(now * 1000).toISOString()}`,
          "ref: #1765 — active trigger with next_fire_at far in the past and last_fire_at IS NULL fires/alerts nothing; a healthy poller drains it within one tick. Inspect: SELECT * FROM bead_triggers WHERE status='active' AND last_fire_at IS NULL AND next_fire_at IS NOT NULL.",
        ].join('\n'),
        'warning',
      );
    } else if (!over && this.triggerPastDueAlertEmitted) {
      clearAlertSourceChecked(
        this.instance,
        'trigger_past_due',
        `pastDueCount=0 (graceSeconds=${this.triggerPastDueGraceSeconds})`,
      );
      this.triggerPastDueAlertEmitted = false;
    }
  }

  private scheduleNext(): void {
    this.timer = this.setTimeoutImpl(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    try {
      await this.tickOnce();
    } catch (err) {
      log.error({ err }, 'unexpected error in tick — rescheduling');
    }
    if (!this.stopped) this.scheduleNext();
  }

  private async processTrigger(t: TriggerRow, now: number): Promise<void> {
    // Terminal-at expiry is handled by the expiry sweep in tickOnce; dueTriggers
    // already filters out rows past terminal_at, so we should never see one here.
    let outcome: ExecuteOutcome;
    try {
      outcome = await this.executeTrigger(t);
    } catch (err) {
      outcome = {
        status: 'failed',
        fired: false,
        outputSummary: 'executor threw',
        outputJson: {},
        errorKind: 'execute_throw',
        errorMessage: errorMessage(err),
      };
    }

    let shouldDispatchNotification = false;
    if (outcome.fired) {
      const throttleRemaining = this.throttleRemainingFor(t.id, now);
      if (throttleRemaining > 0) {
        // Suppress the WhatsApp dispatch but still record fired=true on the
        // run with a throttled marker. Operators inspecting trigger_runs see
        // that the watch matched without their report chat getting spammed.
        outcome.outputJson = {
          ...outcome.outputJson,
          throttled: true,
          throttleRemainingSec: throttleRemaining,
        };
      } else {
        shouldDispatchNotification = true;
      }
    }

    const finishedAt = this.nowFn();
    let runId = 0;
    const postCommitActions: PostCommitActions = {};
    this.db.exec('BEGIN');
    try {
      runId = this.insertRun(t, now);
      this.finishRun(runId, now, finishedAt, outcome, null);
      this.scheduleNextFire(t, now, outcome, postCommitActions);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw err;
    }

    if (postCommitActions.pauseNotificationFailureCount != null) {
      await this.dispatchPauseNotification(t, postCommitActions.pauseNotificationFailureCount);
    }
    if (shouldDispatchNotification) {
      // Notification dispatch is intentionally post-commit. A crash between
      // COMMIT and sendMessage is at-most-once delivery for this poller tick.
      const dispatch = await this.dispatchNotification(t, outcome);
      if (dispatch.waId) {
        try {
          this.recordDeliveredWaMessageId(runId, dispatch.waId);
        } catch (err) {
          log.error({ err, triggerId: t.id, runId }, 'failed to record trigger notification receipt');
        }
      } else if (dispatch.failed && dispatch.terminalReject) {
        // #1745 — delivery was PERMANENTLY rejected for this target (forbidden/403:
        // the bot was removed from the report chat). Retrying the same chat is
        // guaranteed-undeliverable, so once this recurs past the small bound we
        // RETIRE the producer (pause + clear next_fire_at) and signal it out-of-
        // band (bead_event + BOT ERRORS alert) — the report chat itself cannot
        // receive the failure notice, which is exactly why the loop ran for days.
        try {
          this.recordNotifyForbiddenTarget(runId);
          const rejects = this.countConsecutiveForbiddenRejects(t.id);
          if (rejects >= this.maxConsecutiveForbiddenRejects) {
            this.retireTriggerOnForbiddenTarget(t, this.nowFn(), rejects);
          }
        } catch (err) {
          log.error({ err, triggerId: t.id, runId }, 'failed to record/retire forbidden-target dispatch');
        }
      } else if (dispatch.failed) {
        // The trigger evaluated and fired, but delivery threw a TRANSIENT error.
        // Mark the already-committed run so a fired-but-undelivered run is
        // distinguishable in telemetry from a throttled one — status is left
        // EXACTLY as finishRun wrote it (the evaluation succeeded) and
        // error_message stays NULL. The trigger keeps rescheduling (fail-loud,
        // never silently retire) — a daily job must survive a transport blip.
        // Throttled / not-eligible runs never reach here (shouldDispatchNotification).
        try {
          this.recordNotifyDispatchFailed(runId);
        } catch (err) {
          log.error({ err, triggerId: t.id, runId }, 'failed to record trigger notification dispatch failure');
        }
      }
    }
  }

  /**
   * Seconds remaining until the next dispatch is allowed for this trigger.
   * 0 means no throttle (no prior dispatch in trigger_runs, or window elapsed).
   */
  private throttleRemainingFor(triggerId: number, now: number): number {
    // Find the most recent run that actually delivered a WhatsApp notification.
    // A delivered run carries a non-null $.deliveredWaMessageId in output_json.
    // json_extract on the JSON path is required here, NOT a `LIKE
    // '%deliveredWaMessageId%'` substring scan: the substring form matches the
    // KEY name anywhere in the column text — so it false-positives on arbitrary
    // operator-query row data serialised under $.sampleRow (e.g. a watch over a
    // table whose rows contain that text) and on a literal-null value — wrongly
    // treating a never-delivered run as delivered and silently throttling future
    // notifications. json_extract(...) IS NOT NULL keys on the real value.
    const row = this.stmtLastDeliveredRun
      .get(triggerId) as { started_at: number } | undefined;
    if (!row) return 0;
    const elapsed = now - row.started_at;
    if (elapsed >= this.notificationThrottleMinIntervalSec) return 0;
    return this.notificationThrottleMinIntervalSec - elapsed;
  }

  private async executeTrigger(t: TriggerRow): Promise<ExecuteOutcome> {
    const kind = t.kind as TriggerKind;
    let spec: unknown;
    try {
      spec = JSON.parse(t.spec_json);
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'spec_json is not valid JSON',
        outputJson: {},
        errorKind: 'spec_parse',
        errorMessage: errorMessage(err),
      };
    }
    try {
      spec = validateTriggerSpec(kind, spec);
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'spec_json failed SPEC_REGISTRY validation',
        outputJson: { kind },
        errorKind: 'spec_invalid',
        errorMessage: errorMessage(err),
      };
    }

    if (kind === 'poll.sqlite') return this.executeSqlite(t, spec as SqliteSpec);
    if (kind === 'poll.pinecone') return this.executePinecone(spec as PineconeTriggerSpec);
    if (kind === 'poll.file') return this.executeFile(t, spec as FileTriggerSpec);
    if (kind === 'poll.url') return this.executeUrl(t, spec as UrlTriggerSpec);
    if (kind === 'poll.shell') {
      // poll.shell was REMOVED FROM CREATION (F2 Slice B): no executor ever
      // existed and the create_watch enum no longer accepts it. The kind is
      // RETAINED INTERNALLY (TriggerKind/ShellSpec/SPEC_REGISTRY) only for
      // legacy fail-closed handling: a legacy persisted row fails CLOSED here
      // rather than crashing or hot-looping as a noop.
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'poll.shell has been removed',
        outputJson: { reason: 'shell_watch_removed' satisfies TriggerReason },
        errorKind: 'shell_watch_removed',
        errorMessage: 'poll.shell watches are removed; no executor exists. Recreate as a different watch kind.',
      };
    }
    if (kind === 'schedule.cron' || kind === 'schedule.at_time') {
      // If the linked bead is an agent_job, the schedule must RUN the prompt as
      // an agent turn — not just post a bare "cron tick fired" notification.
      // (Bug fix: previously every agent_job schedule silently no-op'd — the
      // prompt in the bead body was never executed.)
      const bead = this.lookupBead(t.bead_id);
      if (bead?.kind === 'agent_job') {
        return this.dispatchAgentJob(t, bead);
      }
      return {
        status: 'ok',
        fired: true,
        outputSummary: kind === 'schedule.at_time' ? 'scheduled one-shot fired' : 'cron tick fired',
        outputJson: { kind },
      };
    }
    if (kind === 'event.message') {
      // event.message is a RESERVED SCAFFOLD owned by a future ingest path, not
      // the interval poller. A freshly created row has next_fire_at=NULL
      // (computeNextFireAt) so dueTriggers never selects it and we should not
      // reach here. Defensive branch: a LEGACY row that somehow carries a
      // non-null next_fire_at must NOT silently churn on the 1h not_implemented
      // cooldown — fail CLOSED with a clear reason and stop polling (the
      // scheduleNextFire fall-through sets next_fire_at=NULL for this kind).
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'event.message is not poller-executed (reserved for ingest path)',
        outputJson: { kind, reason: 'event_message_not_polled' satisfies TriggerReason },
        errorKind: 'event_message_not_polled',
        errorMessage: 'event.message triggers are event-driven (ingest path), not interval-polled; this legacy row will not be rescheduled.',
      };
    }
    // Other kinds: recognised but not yet wired.
    return {
      status: 'noop',
      fired: false,
      outputSummary: `kind ${kind} not yet implemented`,
      outputJson: { kind, reason: 'not_implemented' satisfies TriggerReason },
    };
  }

  private lookupBead(beadId: number): { kind: string; title: string; body: string | null } | undefined {
    return this.stmtLookupBead
      .get(beadId) as { kind: string; title: string; body: string | null } | undefined;
  }

  /**
   * Run an agent_job-linked schedule fire as a real agent turn. Fails CLOSED on
   * every error path (no dispatcher wired, empty prompt, enqueue rejected,
   * dispatcher threw): the run is recorded `failed` with a named errorKind AND
   * fired=true, so the report chat gets an immediate operator alert — never a
   * silent success. On success the run is `ok` with fired=false (no
   * notification: the agent turn itself does the visible work in-chat).
   */
  private dispatchAgentJob(
    t: TriggerRow,
    bead: { title: string; body: string | null },
  ): ExecuteOutcome {
    const prompt = bead.body?.trim();
    if (!prompt) {
      return {
        status: 'failed', fired: true,
        outputSummary: 'agent job dispatch FAILED — empty prompt body',
        outputJson: { kind: t.kind, agentJob: true, reason: 'agent_job_empty_body' },
        errorKind: 'agent_job_empty_body',
        errorMessage: 'agent_job bead has no body to run as a turn',
      };
    }
    if (!this.agentJobDispatch) {
      return {
        status: 'failed', fired: true,
        outputSummary: 'agent job dispatch FAILED — no agent runtime wired on this instance',
        outputJson: { kind: t.kind, agentJob: true, reason: 'agent_job_dispatcher_unavailable' },
        errorKind: 'agent_job_dispatcher_unavailable',
        errorMessage: 'no agentJobDispatch injected; this poller instance cannot run agent turns',
      };
    }
    let result: AgentJobDispatchResult;
    try {
      result = this.agentJobDispatch({
        beadId: t.bead_id, triggerId: t.id,
        prompt, title: bead.title, reportChatJid: t.report_chat_jid,
      });
    } catch (err) {
      return {
        status: 'failed', fired: true,
        outputSummary: `agent job dispatch FAILED — ${errorMessage(err)}`,
        outputJson: { kind: t.kind, agentJob: true, reason: 'agent_job_dispatch_threw' },
        errorKind: 'agent_job_dispatch_threw',
        errorMessage: errorMessage(err),
      };
    }
    if (!result.dispatched) {
      const detail = result.detail ?? 'turn queue rejected the job (queue full?)';
      return {
        status: 'failed', fired: true,
        outputSummary: `agent job dispatch FAILED — ${detail}`,
        outputJson: { kind: t.kind, agentJob: true, reason: 'agent_job_enqueue_rejected' },
        errorKind: 'agent_job_enqueue_rejected',
        errorMessage: detail,
      };
    }
    return {
      status: 'ok', fired: false,
      outputSummary: 'agent job dispatched — turn enqueued',
      outputJson: { kind: t.kind, agentJob: true, detail: result.detail ?? null },
    };
  }

  private executeSqlite(t: TriggerRow, spec: SqliteSpec): ExecuteOutcome {
    // Runtime guard for specs persisted before validation existed (#1096):
    // query_only does not block ATTACH/cross-DB reads, so reject them here too.
    if (!isSafeSqliteSql(spec.sql)) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'unsafe SQL rejected',
        outputJson: { reason: 'unsafe_sql' satisfies TriggerReason },
        errorKind: 'unsafe_sql',
        errorMessage: 'poll.sqlite rejects ATTACH/DETACH/PRAGMA and multi-statement SQL',
      };
    }
    let rows: Record<string, unknown>[];
    let capExceeded = false;
    try {
      // Operator-stored SQL runs against the live bot.db. Bound the blast
      // radius of a compromised or confused-deputy spec by flipping the
      // connection to read-only for the duration of this query. The OFF
      // restoration MUST be in finally so the poller's own follow-up writes
      // (UPDATE bead_triggers, INSERT trigger_runs) still succeed.
      this.db.exec('PRAGMA query_only = ON');
      try {
        const stmt = this.db.prepare(spec.sql);
        const bindArgs = spec.binds ? toBindArgs(spec.binds) : [];
        // QR-026: iterate with a hard row cap instead of `.all()`. A runaway
        // recursive CTE is bounded at MAX_SQLITE_ROWS pulls (breaking the
        // iterator stops the query) rather than materializing unboundedly and
        // OOM-crashing the process.
        rows = [];
        for (const row of stmt.iterate(...bindArgs)) {
          if (rows.length >= MAX_SQLITE_ROWS) { capExceeded = true; break; }
          rows.push(row as Record<string, unknown>);
        }
      } finally {
        this.db.exec('PRAGMA query_only = OFF');
      }
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'SQL execution failed',
        outputJson: { sql: spec.sql },
        errorKind: 'sql_error',
        errorMessage: errorMessage(err),
      };
    }
    if (capExceeded) {
      // The query produced more than MAX_SQLITE_ROWS rows — almost certainly an
      // unbounded/recursive or misconfigured spec. Fail (the circuit breaker will
      // pause it after repeated failures) rather than acting on a truncated set.
      return {
        status: 'failed',
        fired: false,
        outputSummary: `SQL exceeded the ${MAX_SQLITE_ROWS}-row cap — rejected`,
        outputJson: { rowCap: MAX_SQLITE_ROWS, sql: spec.sql },
        errorKind: 'row_cap_exceeded',
        errorMessage: `poll.sqlite result exceeded ${MAX_SQLITE_ROWS} rows — query rejected to bound DoS risk (unbounded/recursive query?)`,
      };
    }

    const rowCount = rows.length;

    if (spec.fire_when === 'rows_returned') {
      return {
        status: rowCount > 0 ? 'ok' : 'noop',
        fired: rowCount > 0,
        outputSummary: rowCount > 0
          ? `SQL returned ${rowCount} row${rowCount === 1 ? '' : 's'}`
          : 'SQL returned 0 rows',
        outputJson: { rowCount, sampleRow: rows[0] ?? null },
      };
    }

    // rowcount_changed: compare to the previous run's rowCount.
    const lastRowCount = this.lastRowCountFor(t.id);
    const changed = lastRowCount === null ? rowCount > 0 : rowCount !== lastRowCount;
    return {
      status: changed ? 'ok' : 'noop',
      fired: changed,
      outputSummary: changed
        ? `rowcount changed: ${lastRowCount ?? 'first run'} -> ${rowCount}`
        : `rowcount unchanged at ${rowCount}`,
      outputJson: { rowCount, lastRowCount },
    };
  }

  private lastRowCountFor(triggerId: number): number | null {
    const row = this.stmtLastRowCountRun
      .get(triggerId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return null;
    try {
      const parsed = JSON.parse(row.output_json) as { rowCount?: unknown };
      return typeof parsed.rowCount === 'number' ? parsed.rowCount : null;
    } catch {
      return null;
    }
  }

  /**
   * poll.pinecone — similarity search over the bot's own memory index.
   *
   * Defense-in-depth (the analogue of `isSafeSqliteSql`): even though
   * `create_watch` validated the spec shape, re-guard the index against the
   * configured allowlist at EXEC time. Empty/unset allowlist = deny-all
   * (fail-closed). The Pinecone client is injected; when absent we fail with
   * `pinecone_unavailable` rather than silently noop. `outputJson` is reduced
   * to scalars (`matchCount`, `topScore`) — record bodies never enter the
   * poller (the search fn returns only scores), parity with the SQL
   * `sampleRow` redaction posture.
   */
  private async executePinecone(spec: PineconeTriggerSpec): Promise<ExecuteOutcome> {
    if (!this.pineconeAllowedIndexes.has(spec.index)) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: `index ${spec.index} not in allowlist`,
        outputJson: { reason: 'index_not_allowed' satisfies TriggerReason },
        errorKind: 'index_not_allowed',
        errorMessage: 'poll.pinecone index is not in config.memory.pinecone.allowedIndexes',
      };
    }
    if (!this.pineconeSearch) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'pinecone search path not configured',
        outputJson: { reason: 'pinecone_unavailable' satisfies TriggerReason },
        errorKind: 'pinecone_unavailable',
        errorMessage: 'poll.pinecone has no Pinecone client wired in this process',
      };
    }

    let matches: PineconeMatch[];
    try {
      const result = await this.pineconeSearch({
        index: spec.index,
        namespace: spec.namespace,
        query: spec.query,
        topK: spec.top_k ?? PINECONE_DEFAULT_TOP_K,
      });
      matches = Array.isArray(result.matches) ? result.matches : [];
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'pinecone query failed',
        outputJson: { index: spec.index },
        errorKind: 'pinecone_error',
        errorMessage: errorMessage(err),
      };
    }

    const matchCount = matches.length;
    const topScore = matchCount > 0
      ? matches.reduce((max, m) => (typeof m.score === 'number' && m.score > max ? m.score : max), -Infinity)
      : null;

    const fired = spec.threshold != null
      ? (topScore != null && topScore >= spec.threshold)
      : matchCount > 0;

    return {
      status: fired ? 'ok' : 'noop',
      fired,
      outputSummary: fired
        ? `pinecone matched ${matchCount} result${matchCount === 1 ? '' : 's'} (top ${topScore ?? 'n/a'})`
        : `pinecone below threshold (${matchCount} results, top ${topScore ?? 'n/a'})`,
      outputJson: { matchCount, topScore },
    };
  }

  /**
   * poll.file — watch a host file for existence / mtime change / content
   * change.
   *
   * Path policy (fail-closed, defense-in-depth analogue of `isSafeSqliteSql`):
   *   1. resolve() the spec path,
   *   2. require it under a configured allowed root (empty set = DENY-ALL —
   *      this INVERTS the agent-sandbox hook's fail-open default because the
   *      poller is unsandboxed in the main process),
   *   3. reject /proc, /dev, /sys prefixes outright,
   *   4. realpath() the target and re-check the resolved path is still under an
   *      allowed root (symlink-escape defense),
   *   5. require a regular file (stat.isFile()).
   * Any failure → status:'failed', errorKind:'path_not_allowed'.
   */
  private async executeFile(t: TriggerRow, spec: FileTriggerSpec): Promise<ExecuteOutcome> {
    const denied = (detail: string): ExecuteOutcome => ({
      status: 'failed',
      fired: false,
      outputSummary: `path rejected: ${detail}`,
      outputJson: { reason: 'path_not_allowed' satisfies TriggerReason },
      errorKind: 'path_not_allowed',
      errorMessage: `poll.file ${detail}`,
    });

    const resolved = resolve(spec.path);
    // Syntactic pre-checks on the lexically-resolved path: reject denied
    // pseudo-fs prefixes outright. The authoritative allowlist comparison runs
    // against the realpath'd target below (symlink-canonical) so platform
    // symlinks (macOS /var -> /private/var) don't cause false escapes.
    if (this.isDeniedPrefix(resolved)) {
      return denied('path is under a denied pseudo-filesystem prefix');
    }

    // Existence + symlink-escape + regular-file checks. A missing file is a
    // legitimate state for watch:'exists' (noop), NOT a policy failure.
    let realTarget: string;
    let st: ReturnType<typeof statSync>;
    try {
      // realpathSync resolves symlinks; if the link escapes the root we catch
      // it below. It throws ENOENT when the file is absent.
      realTarget = realpathSync(resolved);
      st = statSync(realTarget);
    } catch {
      // File absent (ENOENT). Still fail-closed if the path the operator named
      // is not under an allowed root — an absent-path noop would otherwise be a
      // file-existence oracle for arbitrary paths. We compare the realpath of
      // the absent target's PARENT directory (the deepest existing ancestor) so
      // platform symlinks on the parent are canonicalised; if even that is not
      // resolvable or escapes, deny.
      if (!this.resolvedAbsentPathAllowed(resolved)) {
        return denied('path is outside the configured allowed roots');
      }
      // An absent file under an allowed root is a benign noop for every watch
      // mode — there is nothing yet to fire on or compare against.
      return {
        status: 'noop',
        fired: false,
        outputSummary: 'file absent',
        outputJson: { exists: false },
      };
    }

    // Symlink-escape defense: the realpath'd target must ALSO be under an
    // allowed root and not a denied pseudo-fs prefix.
    if (this.isDeniedPrefix(realTarget) || !this.isUnderAllowedRoot(realTarget)) {
      return denied('symlink target escapes the allowed roots');
    }
    if (!st.isFile()) {
      return denied('target is not a regular file');
    }

    if (spec.watch === 'exists') {
      return {
        status: 'ok',
        fired: true,
        outputSummary: 'file present',
        outputJson: { exists: true },
      };
    }

    if (spec.watch === 'mtime') {
      const mtime = Math.floor(st.mtimeMs);
      const last = this.lastMtimeFor(t.id);
      const fired = last === null ? true : mtime !== last;
      return {
        status: fired ? 'ok' : 'noop',
        fired,
        outputSummary: fired
          ? `mtime changed: ${last ?? 'first run'} -> ${mtime}`
          : `mtime unchanged at ${mtime}`,
        outputJson: { exists: true, mtime },
      };
    }

    // content_hash
    let hash: string;
    try {
      hash = await hashFileCapped(realTarget, FILE_HASH_MAX_BYTES);
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'content hash failed',
        outputJson: { exists: true },
        errorKind: 'hash_error',
        errorMessage: errorMessage(err),
      };
    }
    const lastHash = this.lastHashFor(t.id);
    const hashChanged = lastHash === null ? true : hash !== lastHash;
    return {
      status: hashChanged ? 'ok' : 'noop',
      fired: hashChanged,
      outputSummary: hashChanged
        ? (lastHash === null ? 'content hash recorded (first run)' : 'content changed')
        : 'content unchanged',
      // Store the hash for the next comparison but keep the surfaced posture
      // scalar/boolean: the hash itself is an opaque digest (not file content),
      // and hashChanged is the operator-facing boolean.
      outputJson: { exists: true, hashChanged, hash },
    };
  }

  private isDeniedPrefix(absPath: string): boolean {
    return DENIED_PATH_PREFIXES.some(
      (prefix) => absPath === prefix || absPath.startsWith(prefix + '/'),
    );
  }

  private isUnderAllowedRoot(absPath: string): boolean {
    // Empty allowlist = deny-all (inverted from the sandbox hook's fail-open).
    if (this.fileWatchAllowedRoots.length === 0) return false;
    return this.fileWatchAllowedRoots.some(
      (root) => absPath === root || absPath.startsWith(root + sep),
    );
  }

  /**
   * Allowlist check for an absent (ENOENT) target. We cannot realpath the
   * target itself, so we canonicalise its deepest existing ancestor and require
   * that ancestor be under an allowed root. This keeps the absent-file noop
   * from acting as an existence oracle for paths outside the allowlist while
   * still tolerating platform symlinks on the parent chain.
   */
  private resolvedAbsentPathAllowed(absPath: string): boolean {
    if (this.fileWatchAllowedRoots.length === 0) return false;
    let current = absPath;
    // Walk up to the deepest existing ancestor.
    for (let i = 0; i < 64; i++) {
      try {
        const realAncestor = realpathSync(current);
        if (this.isDeniedPrefix(realAncestor)) return false;
        // The absent leaf sits under `current`; require the canonical ancestor
        // to be at or under an allowed root.
        return this.isUnderAllowedRoot(realAncestor);
      } catch {
        const parent = resolve(current, '..');
        if (parent === current) return false; // reached filesystem root
        current = parent;
      }
    }
    return false;
  }

  /** Prior run's recorded file mtime, mirroring `lastRowCountFor`. */
  private lastMtimeFor(triggerId: number): number | null {
    return this.lastScalarFor(triggerId, 'mtime');
  }

  /** Prior run's recorded content hash, mirroring `lastRowCountFor`. */
  private lastHashFor(triggerId: number): string | null {
    const row = this.stmtLastHashRun
      .get(triggerId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return null;
    try {
      const parsed = JSON.parse(row.output_json) as { hash?: unknown };
      return typeof parsed.hash === 'string' ? parsed.hash : null;
    } catch {
      return null;
    }
  }

  /**
   * poll.url — fetch a URL and fire on a change in the body / a selected
   * subtree / a header subset (change detection).
   *
   * Controls (defense-in-depth; the create_watch creation-throw is the first
   * gate, this is the exec-time re-guard):
   *   1. Gated default-OFF: if `enableUrlWatch` is false → `url_watch_disabled`
   *      (a row persisted while ON still fails closed once the flag is OFF).
   *   2. https-only (reject any non-https scheme).
   *   3. Default-port-only (reject any explicit non-443 port).
   *   4. SSRF fail-CLOSED: the fetch runs through the shared `ssrfSafeAgent`
   *      stack (per-hop resolved-IP revalidation, body-cap, timeout); a blocked
   *      private/loopback/metadata host throws `SsrfBlockedError` →
   *      `ssrf_blocked` (NOT the soft fallback the link-preview path uses).
   *
   * `outputJson` is reduced to scalars/booleans (`hashChanged` + the opaque
   * digest used for the next comparison) — the fetched body NEVER enters
   * output_json (parity with the SQL `sampleRow` / pinecone redaction posture).
   */
  private async executeUrl(t: TriggerRow, spec: UrlTriggerSpec): Promise<ExecuteOutcome> {
    if (!this.enableUrlWatch) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'url watch is disabled',
        outputJson: { reason: 'url_watch_disabled' satisfies TriggerReason },
        errorKind: 'url_watch_disabled',
        errorMessage: 'poll.url is disabled; set advanced.enableUrlWatch:true to enable',
      };
    }

    const ssrfBlocked = (detail: string): ExecuteOutcome => ({
      status: 'failed',
      fired: false,
      outputSummary: `url rejected: ${detail}`,
      outputJson: { reason: 'ssrf_blocked' satisfies TriggerReason },
      errorKind: 'ssrf_blocked',
      errorMessage: `poll.url ${detail}`,
    });

    let parsed: URL;
    try {
      parsed = new URL(spec.url);
    } catch {
      return ssrfBlocked('url is not parseable');
    }
    // https-only — reject http:// and any other scheme fail-closed.
    if (parsed.protocol !== 'https:') {
      return ssrfBlocked('only https URLs are allowed');
    }
    // Default-port-only — reject any explicit non-443 port.
    if (!URL_WATCH_ALLOWED_PORTS.has(parsed.port)) {
      return ssrfBlocked(`non-default port ${parsed.port} is not allowed`);
    }

    let result: GuardedFetchResult;
    try {
      result = await this.urlFetch(spec.url, { maxBytes: URL_WATCH_MAX_BYTES });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return ssrfBlocked(`blocked (${err.reason})`);
      }
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'url fetch failed',
        outputJson: { reason: 'fetch_error' satisfies TriggerReason },
        errorKind: 'fetch_error',
        errorMessage: errorMessage(err),
      };
    }

    let hashInput: string;
    if (spec.hash_mode === 'headers') {
      hashInput = await hashUrlHeaders(result.headers);
    } else if (spec.hash_mode === 'selector') {
      hashInput = await hashUrlSelector(result.body, spec.selector ?? '');
    } else {
      hashInput = result.body;
    }
    const hash = createHash('sha256').update(hashInput).digest('hex');

    const lastHash = this.lastUrlHashFor(t.id);
    const hashChanged = lastHash === null ? true : hash !== lastHash;
    return {
      status: hashChanged ? 'ok' : 'noop',
      fired: hashChanged,
      outputSummary: hashChanged
        ? (lastHash === null ? 'url hash recorded (first run)' : 'url content changed')
        : 'url content unchanged',
      // Scalars/booleans only — the hash is an opaque digest, never the body.
      outputJson: { hashChanged, urlHash: hash, hashMode: spec.hash_mode },
    };
  }

  /** Prior run's recorded poll.url digest, mirroring `lastHashFor`. */
  private lastUrlHashFor(triggerId: number): string | null {
    const row = this.stmtLastUrlHashRun
      .get(triggerId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return null;
    try {
      const parsed = JSON.parse(row.output_json) as { urlHash?: unknown };
      return typeof parsed.urlHash === 'string' ? parsed.urlHash : null;
    } catch {
      return null;
    }
  }

  private lastScalarFor(triggerId: number, key: string): number | null {
    const row = this.stmtLastScalarRun
      .get(triggerId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return null;
    try {
      const parsed = JSON.parse(row.output_json) as Record<string, unknown>;
      const value = parsed[key];
      return typeof value === 'number' ? value : null;
    } catch {
      return null;
    }
  }

  private async dispatchNotification(t: TriggerRow, outcome: ExecuteOutcome): Promise<NotificationDispatch> {
    const text = formatNotification(t, outcome);
    try {
      const receipt = await this.messenger.sendMessage(t.report_chat_jid, text);
      return { waId: receipt.waMessageId ?? null, failed: false, terminalReject: false };
    } catch (err) {
      const terminalReject = isForbiddenTargetReject(err);
      log.error(
        { err, triggerId: t.id, reportChatJid: t.report_chat_jid, terminalReject },
        'failed to dispatch trigger notification',
      );
      return { waId: null, failed: true, terminalReject };
    }
  }

  private insertRun(t: TriggerRow, startedAt: number): number {
    const info = this.stmtInsertRun
      .run(t.id, t.bead_id, startedAt);
    return Number(info.lastInsertRowid);
  }

  private finishRun(
    runId: number,
    startedAt: number,
    finishedAt: number,
    outcome: ExecuteOutcome,
    deliveredWaId: string | null,
  ): void {
    const durationMs = Math.max(0, (finishedAt - startedAt) * 1000);
    const outputJson = deliveredWaId
      ? { ...outcome.outputJson, deliveredWaMessageId: deliveredWaId }
      : outcome.outputJson;
    this.stmtFinishRun.run(
      outcome.status,
      finishedAt,
      durationMs,
      outcome.outputSummary,
      JSON.stringify(outputJson),
      outcome.errorKind ?? null,
      outcome.errorMessage ?? null,
      runId,
    );
  }

  private recordDeliveredWaMessageId(runId: number, deliveredWaId: string): void {
    this.stmtRecordDeliveredWaMessageId.run(deliveredWaId, runId);
  }

  /**
   * Post-commit: a fired trigger's notification delivery threw. Record it on the
   * run row without disturbing the committed trigger-evaluation result — only
   * error_kind is set; status and error_message are left untouched. The
   * error_kind IS NULL guard is defense-in-depth: today every fired:true outcome
   * commits error_kind=NULL, but that invariant is spread across every outcome
   * branch — the guard makes sure a future fired-with-classification outcome
   * cannot have its execute classification silently replaced by a delivery note.
   */
  private recordNotifyDispatchFailed(runId: number): void {
    this.stmtRecordNotifyDispatchFailed.run(runId);
  }

  /**
   * #1745 — mark a fired run whose notification delivery was PERMANENTLY
   * rejected for the target chat (forbidden/403). A distinct error_kind from
   * `notify_dispatch_failed` so the consecutive-reject circuit breaker (which
   * reads error_kind, unlike the status-only countConsecutiveFailures) can
   * count only permanent per-target rejects and never a transient blip. Same
   * `error_kind IS NULL` guard as recordNotifyDispatchFailed: a fired outcome
   * commits error_kind=NULL, so this never clobbers an execute classification.
   */
  private recordNotifyForbiddenTarget(runId: number): void {
    this.stmtRecordNotifyForbiddenTarget.run(runId);
  }

  /**
   * #1745 — count consecutive most-recent runs whose notification was
   * forbidden-target rejected, stopping at the first run that was NOT (a
   * successful delivery, a noop, or a transient failure resets the streak).
   * Mirrors countConsecutiveFailures but keys on the forbidden-target
   * error_kind rather than status — the reported producer is a schedule.cron
   * trigger, which never reaches the status-based breaker (it always
   * reschedules), so status alone can never bound this loop.
   */
  private countConsecutiveForbiddenRejects(triggerId: number): number {
    const recent = this.stmtRecentErrorKinds
      .all(triggerId, this.maxConsecutiveForbiddenRejects) as Array<{ error_kind: string | null }>;
    let count = 0;
    for (const row of recent) {
      if (row.error_kind === 'notify_forbidden_target') count++;
      else break;
    }
    return count;
  }

  /**
   * #1745 — retire a producer whose target chat permanently rejects delivery:
   * pause the trigger and clear next_fire_at (so dueTriggers can never select
   * it again — bounding the quarantine that its fires would otherwise keep
   * feeding), write a `trigger_paused` bead_event with reason `forbidden_target`
   * (the producer signal, readable by the bead owner surface), and emit a
   * BOT ERRORS alert naming the bead/trigger/chat. The alert is the out-of-band
   * channel BECAUSE the report chat itself is undeliverable — the exact gap that
   * let the incident run silently for ~4 days. `status='active'` guard keeps the
   * pause idempotent.
   */
  private retireTriggerOnForbiddenTarget(t: TriggerRow, now: number, rejectCount: number): void {
    const info = this.stmtRetireTriggerOnForbiddenTarget.run(now, t.id);
    if (info.changes === 0) return; // already retired by a prior tick — do not double-signal
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'trigger_paused',
      actor: 'trigger-poller',
      payload: {
        trigger_id: t.id,
        reason: 'forbidden_target',
        report_chat_jid: t.report_chat_jid,
        reject_count: rejectCount,
      },
      at: now,
    });
    if (this.instance) {
      emitAlertChecked(
        this.instance,
        'trigger_forbidden_target',
        `whatsoup@${this.instance} retired trigger ${t.id} (bead ${t.bead_id}) after ${rejectCount} consecutive forbidden-target send rejections to ${t.report_chat_jid}`,
        [
          `triggerId=${t.id}`,
          `beadId=${t.bead_id}`,
          `reportChatJid=${t.report_chat_jid}`,
          `consecutiveForbiddenRejects=${rejectCount}`,
          `retiredAt=${new Date(now * 1000).toISOString()}`,
          'ref: #1745 — the target chat permanently rejects delivery (bot removed from the group); the trigger is paused so it stops looping and stops feeding the quarantine. Re-arm only after the bot is re-added, or delete the producing bead.',
        ].join('\n'),
        'warning',
      );
    }
  }

  private scheduleNextFire(
    t: TriggerRow,
    now: number,
    outcome: ExecuteOutcome,
    postCommitActions: PostCommitActions,
  ): void {
    let nextFireAt: number | null = null;

    if (t.kind === 'schedule.at_time') {
      // One-shot: expire after firing rather than rescheduling.
      this.markExpired(t, now, 'one_shot_completed');
      return;
    }

    if (t.kind === 'schedule.cron') {
      try {
        // QR-092: honor the persisted tz on reschedule (parity with computeNextFireAt
        // and the scheduled_messages path); default to UTC when absent.
        const parsed = JSON.parse(t.spec_json) as { expr: string; tz?: string };
        nextFireAt = nextCronRun(parsed.expr, now, parsed.tz ?? 'UTC');
      } catch (err) {
        log.error({ err, triggerId: t.id }, 'cron next-fire computation failed');
        nextFireAt = now + FAILED_RETRY_COOLDOWN_SEC;
      }
    } else if (t.kind === 'event.message') {
      // Reserved scaffold, never poller-executed. A legacy row that reached the
      // executor failed CLOSED above; do not churn it on any cooldown — clear
      // next_fire_at so it sits inert (it still TTL-expires via the sweep).
      nextFireAt = null;
    } else if (outcome.outputJson.reason === 'not_implemented') {
      nextFireAt = now + NOT_IMPLEMENTED_COOLDOWN_SEC;
    } else if (outcome.status === 'failed') {
      // Circuit breaker: count consecutive failures including this one.
      // If we've hit the threshold, pause the trigger instead of scheduling
      // another retry — otherwise auto-compact-style retry storms blow up
      // when a target table disappears or a remote service stays down.
      const consecutiveFailures = this.countConsecutiveFailures(t.id);
      if (consecutiveFailures >= this.maxConsecutiveFailures) {
        if (this.markPausedOnFailures(t, now, consecutiveFailures)) {
          postCommitActions.pauseNotificationFailureCount = consecutiveFailures;
        }
        return;
      }
      nextFireAt = now + FAILED_RETRY_COOLDOWN_SEC;
    } else if (t.interval_seconds && t.interval_seconds > 0) {
      nextFireAt = now + t.interval_seconds;
    } else {
      // No interval and not a schedule — disable to avoid re-firing.
      nextFireAt = null;
    }

    this.stmtScheduleNextFire.run(nextFireAt, now, now, t.id);
  }

  /**
   * Counts consecutive failed runs in trigger_runs, ordered by most recent
   * first, stopping at the first non-failed run. A successful or noop run
   * resets the implicit counter.
   */
  private countConsecutiveFailures(triggerId: number): number {
    const recent = this.stmtRecentRunStatuses
      .all(triggerId, this.maxConsecutiveFailures) as Array<{ status: string }>;
    let count = 0;
    for (const row of recent) {
      if (row.status === 'failed') count++;
      else break;
    }
    return count;
  }

  private markPausedOnFailures(t: TriggerRow, now: number, failureCount: number): boolean {
    this.stmtMarkPausedOnFailures.run(now, t.id);
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'trigger_paused',
      actor: 'trigger-poller',
      payload: { trigger_id: t.id, reason: 'consecutive_failures', failure_count: failureCount },
      at: now,
    });
    return t.on_terminal !== 'silent';
  }

  private async dispatchPauseNotification(t: TriggerRow, failureCount: number): Promise<void> {
    try {
      await this.messenger.sendMessage(
        t.report_chat_jid,
        formatPauseNotification(t, failureCount),
      );
    } catch (err) {
      log.error({ err, triggerId: t.id }, 'failed to dispatch pause notification');
    }
  }

  private expireTrigger(t: TriggerRow, now: number): void {
    let shouldDispatchExpiryNotification = false;
    this.db.exec('BEGIN');
    try {
      shouldDispatchExpiryNotification = this.markExpired(t, now, 'terminal_at_reached');
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw err;
    }
    if (shouldDispatchExpiryNotification) {
      void this.messenger.sendMessage(
        t.report_chat_jid,
        formatExpiryNotification(t, 'terminal_at_reached'),
      ).catch((err: unknown) => {
        log.error({ err, triggerId: t.id }, 'failed to dispatch expiry notification');
      });
    }
  }

  /**
   * Reasons that should NOT trigger an on_terminal='notify' message because
   * the trigger just successfully fired and the user already received the
   * fire notification. Adding a second "expired" message would double-notify.
   */
  private static readonly SILENT_EXPIRY_REASONS = new Set(['one_shot_completed']);

  private markExpired(t: TriggerRow, now: number, reason: string): boolean {
    this.stmtMarkExpiredTrigger.run(now, t.id);
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'trigger_expired',
      actor: 'trigger-poller',
      payload: { trigger_id: t.id, reason, on_terminal: t.on_terminal },
      at: now,
    });
    this.stmtInsertExpiryRun.run(
      t.id, t.bead_id, now, now,
      `trigger expired: ${reason}`,
      JSON.stringify({ reason, on_terminal: t.on_terminal }),
    );
    if (t.on_terminal === 'reopen_bead') {
      this.reopenTerminalBead(t, now, reason);
    }
    return t.on_terminal === 'notify' && !TriggerPoller.SILENT_EXPIRY_REASONS.has(reason);
  }

  private reopenTerminalBead(t: TriggerRow, now: number, reason: string): void {
    const bead = this.stmtLookupBeadStatus
      .get(t.bead_id) as { status: BeadStatus } | undefined;
    if (!bead || !TERMINAL.includes(bead.status)) return;

    // This is the inverse of the normal terminal transition: transition()
    // intentionally rejects terminal beads, so reopen_bead writes the status
    // and matching status_change event directly inside the expiry transaction.
    this.stmtReopenBead.run(now, t.bead_id);
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'status_change',
      actor: 'trigger-poller',
      payload: {
        from: bead.status,
        to: 'active',
        reason: 'trigger_terminal_reopen',
        trigger_id: t.id,
        trigger_reason: reason,
      },
      at: now,
    });
  }
}

function formatNotification(t: TriggerRow, outcome: ExecuteOutcome): string {
  const heading = t.kind === 'schedule.at_time'
    ? 'Scheduled fire'
    : t.kind === 'schedule.cron'
      ? 'Cron tick'
      : 'Watch fired';
  return `*${heading}* (trigger ${t.id}) — ${outcome.outputSummary}`;
}

function formatExpiryNotification(t: TriggerRow, reason: string): string {
  return `*Watch expired* (trigger ${t.id}, bead ${t.bead_id}) — ${reason}`;
}

function formatPauseNotification(t: TriggerRow, failureCount: number): string {
  return `*Watch paused* (trigger ${t.id}, bead ${t.bead_id}) — paused after ${failureCount} consecutive failures. Inspect via list_triggers; resume with extend_trigger or recreate.`;
}

function canonicalizeAllowedRoot(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    // If the configured root does not exist yet, canonicalize the deepest
    // existing ancestor and append the missing suffix. This preserves future
    // roots under platform symlinks such as macOS /var -> /private/var.
    const missingSegments: string[] = [];
    let current = abs;
    for (let i = 0; i < 64; i++) {
      try {
        return resolve(realpathSync(current), ...missingSegments.reverse());
      } catch {
        const parent = resolve(current, '..');
        if (parent === current) return abs;
        missingSegments.push(basename(current));
        current = parent;
      }
    }
    return abs;
  }
}

/**
 * Stream a SHA-256 over a file, stopping after `maxBytes`. Bounds the read so a
 * confused-deputy `poll.file` spec pointed at a huge file cannot exhaust memory
 * or stall the poller. Reading only the prefix is still a stable change
 * detector (any prefix change flips the digest).
 */
function hashFileCapped(filePath: string, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let read = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise(hash.digest('hex'));
    };
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const remaining = maxBytes - read;
      if (remaining <= 0) {
        stream.destroy();
        return;
      }
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      hash.update(slice);
      read += slice.length;
      if (read >= maxBytes) stream.destroy();
    });
    // EOF or a destroy()-driven close both terminate the read; `finish` is
    // idempotent so whichever fires first computes the digest exactly once.
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Stable change-detection string over a header subset (hash_mode:'headers').
 * Only a fixed allowlist of caching/identity headers is included so the digest
 * is deterministic and small; values are joined in a fixed key order.
 */
async function hashUrlHeaders(headers: Record<string, string>): Promise<string> {
  return URL_WATCH_HASH_HEADERS.map((k) => `${k}=${headers[k] ?? ''}`).join('\n');
}

/**
 * Extract and serialise the selected subtree (hash_mode:'selector') so the
 * digest reflects only that region of the page. Uses cheerio (already a project
 * dep, dynamically imported like the link-preview path). A missing/invalid
 * selector hashes the empty string, so an absent element is a stable state.
 */
async function hashUrlSelector(html: string, selector: string): Promise<string> {
  if (!selector) return '';
  try {
    const { load } = await import('cheerio');
    const $ = load(html);
    return $(selector).html() ?? '';
  } catch {
    // On a selector/parse failure, fall back to a stable empty marker rather
    // than throwing — keeps change-detection deterministic.
    return '';
  }
}

export function toBindArgs(binds: unknown[] | Record<string, unknown>): SQLInputValue[] {
  // node:sqlite supports positional binds via .all(...args); named binds are
  // not part of the public API. Build SQL with positional `?` placeholders and
  // pass an ARRAY whose element order matches the placeholders — arrays are the
  // reliable positional form. A legacy object is still accepted for back-compat,
  // but `Object.values` reorders integer-like keys ("0","1",…) numerically
  // regardless of source order, so object binds with 2+ values are unsafe; new
  // recipes should use an array.
  if (Array.isArray(binds)) return binds as SQLInputValue[];
  return Object.values(binds) as SQLInputValue[];
}
