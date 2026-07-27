// scripts/lib/durability-status-registry.ts
//
// PURE data + tiny pure helpers for the #1789 durability-writer invariant. No
// filesystem, no database, no process access — `scripts/durability-writer-guard.ts`
// and `tests/scripts/durability-writer-guard.test.ts` both import this module so
// the guard and its test see the exact same declarations.
//
// #1789, precisely (see docs/proposals/2026-07-20-durability-writer-invariant.md):
// a status-bearing durability table can be "structurally incapable of reporting
// bad news" when its terminal-failure value has no production writer — the row
// exists, the vocabulary includes a failure state, but nothing in `src/` (outside
// tests) ever writes it. `auth_loss_signal` was exactly this until #1786 wired it.
// This registry is the enumeration that makes the defect class impossible to
// reship silently: every table `migratedSchemaSnapshot()` returns must be
// classified into EXACTLY ONE of three buckets (status-bearing / non-status /
// declared-reserved-exception), and every status-bearing entry must declare a
// non-empty terminal-failure vocabulary plus at least one writer site.
//
// Completeness is TOTAL by design — the guard's check (1) fails closed on any
// migrated table this file does not mention, which is what forces a future
// author touching schema to register it here rather than ship silently.
//
// HONEST SCOPE, precisely (a gap this file used to overclaim past): "every
// table" above means every table `migratedSchemaSnapshot()` returns, PLUS
// every table discovered by the guard's static `CREATE TABLE` scan across
// `src/**/*.ts` that is declared self-provisioned or excluded below
// (`SELF_PROVISIONED`, `DISCOVERY_EXCLUSIONS`). Six real, live tables are
// created OUTSIDE the migration registry by self-provisioning `ensureXSchema`
// functions and are invisible to `migratedSchemaSnapshot()` — a completeness
// claim scoped only to the snapshot would silently miss them. The discovery
// scan (guard check 1b) is what closes that blind spot: any `CREATE TABLE`
// text occurrence under `src/` that isn't in the snapshot, `SELF_PROVISIONED`,
// or `DISCOVERY_EXCLUSIONS` fails the guard.

/** How a status column's known vocabulary was established. */
export type VocabularySource = 'sql-check' | 'ts-union' | 'literal';

export interface DurabilityStatusEntry {
  /** SQLite table name, matching `migratedSchemaSnapshot()`. */
  table: string;
  /**
   * The column carrying the table's own lifecycle status, or `null` when the
   * table has no dedicated status column and a row's mere existence (or an
   * unresolved marker column) is itself the terminal-failure evidence — e.g.
   * `decryption_failures` (failure-by-construction) and `auth_loss_signal`
   * (an open `logged_out` row IS the signal).
   */
  statusColumn: string | null;
  /** The column's known value set (informational; not exhaustively enforced). */
  vocabulary: string[];
  vocabularySource: VocabularySource;
  /**
   * The subset of `vocabulary` (or, for column-less/free-text tables, a
   * descriptive literal) that represents TERMINAL FAILURE — the value this
   * invariant exists to make sure something actually writes. Must be non-empty.
   */
  terminalFailureValues: string[];
  /**
   * Repo-relative, non-test `src/` file(s) that write (or, for free-text
   * columns, insert) the terminal-failure evidence. See the guard's header for
   * the exact, honestly-scoped meaning of "writer site" here.
   */
  writerSites: string[];
}

export interface ReservedEntry {
  table: string;
  /** Non-empty: why this status-bearing table is EXEMPT from the writer-invariant check. */
  reason: string;
  /** Non-empty: the tracking issue for the exemption. */
  issue: string;
}

export interface UnwiredTerminalEntry {
  /** A LIVE, still-classified status-bearing table (stays in KNOWN_STATUS_TABLES / REGISTRY). */
  table: string;
  /**
   * The specific declared terminal-failure value that has NO resolvable
   * production writer today. Unlike `ReservedEntry`, this does not exempt the
   * whole table — only this one value's writer-existence proof.
   */
  terminalValue: string;
  /** Non-empty: what's true today and why it isn't fixed yet. */
  reason: string;
  /** Non-empty: the tracking issue for the gap. */
  issue: string;
}

export interface SelfProvisionedEntry {
  /** A real, live table created OUTSIDE the migration registry — invisible to `migratedSchemaSnapshot()`. */
  table: string;
  /** Repo-relative `src/` module whose `ensureXSchema`-style function self-provisions this table. */
  module: string;
  /** Non-empty: why this table lives outside the numbered migration registry. */
  reason: string;
  /**
   * Required ONLY if this table's DDL text matches the anti-dodge
   * `STATUS_LIKE_COLUMN_RE` (guard check 1b's extension, enforced): a
   * truthful explanation of why the status-shaped column isn't a
   * #1789-relevant status column. Optional otherwise.
   */
  justification?: string;
}

export interface DiscoveryExclusionEntry {
  /** A `CREATE TABLE` name the discovery scan will find, that is NOT a real persisted table. */
  table: string;
  /** Non-empty: why a discovered CREATE TABLE for this name never yields a lasting table. */
  reason: string;
}

/**
 * One entry per status-bearing durability table with a resolvable terminal-failure
 * writer, verified directly against this worktree (file:line anchors drift; the
 * literal-presence check in the guard is what actually stays honest over time).
 */
export const REGISTRY: DurabilityStatusEntry[] = [
  {
    table: 'tool_calls',
    statusColumn: 'status',
    vocabulary: ['pending', 'executing', 'complete', 'error', 'replayed', 'quarantined'],
    vocabularySource: 'ts-union',
    terminalFailureValues: ['error'],
    writerSites: ['src/core/durability.ts'], // ToolCallStatus union + markToolComplete()
  },
  {
    table: 'trigger_runs',
    statusColumn: 'status',
    vocabulary: ['queued', 'running', 'ok', 'noop', 'failed', 'terminal_fired'],
    vocabularySource: 'sql-check',
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/substrate/poller.ts'], // finishRun() writes outcome.status
  },
  {
    table: 'auth_loss_signal',
    statusColumn: 'classifier',
    vocabulary: ['logged_out', 'weak_logged_out_signal'],
    vocabularySource: 'sql-check',
    terminalFailureValues: ['logged_out'],
    // #1786 wiring: transport-adjacent poller records the classified loss;
    // the store performs the dedup-aware insert.
    writerSites: ['src/fleet/health-poller.ts', 'src/fleet/auth-loss-signal-store.ts'],
  },
  {
    table: 'inbound_events',
    statusColumn: 'processing_status',
    vocabulary: ['pending', 'processing', 'turn_done', 'complete', 'failed'],
    vocabularySource: 'ts-union',
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/durability.ts'],
  },
  {
    table: 'outbound_ops',
    statusColumn: 'status',
    vocabulary: ['pending', 'sending', 'submitted', 'echoed', 'maybe_sent', 'failed_permanent', 'quarantined'],
    vocabularySource: 'ts-union',
    terminalFailureValues: ['failed_permanent', 'quarantined'],
    writerSites: ['src/core/durability.ts'],
  },
  {
    table: 'session_checkpoints',
    statusColumn: 'session_status',
    vocabulary: ['active', 'suspended', 'orphaned', 'ended'],
    vocabularySource: 'ts-union',
    terminalFailureValues: ['orphaned'],
    writerSites: ['src/core/durability.ts'],
  },
  {
    table: 'turn_recovery_jobs',
    statusColumn: 'state',
    vocabulary: ['blocked_unsafe', 'pending', 'claimed', 'completed', 'exhausted'],
    vocabularySource: 'sql-check',
    terminalFailureValues: ['exhausted'],
    writerSites: ['src/core/turn-recovery-store.ts'],
  },
  {
    table: 'agent_sessions',
    statusColumn: 'status',
    vocabulary: ['active', 'suspended', 'ended', 'completed', 'crashed', 'resume_failed', 'orphaned'],
    // No SQL CHECK, no exported TS union — vocabulary lives as scattered string
    // literals (TERMINAL_STATUSES in session-db.ts and the rowStatus default
    // below). Modelled honestly as 'literal', not 'ts-union'.
    vocabularySource: 'literal',
    terminalFailureValues: ['crashed', 'resume_failed'],
    // The literal 'crashed'/'resume_failed' values are decided and typed here
    // (closeDurableFailureLifecycle); the executing UPDATE lives in
    // session-lifecycle-store.ts but receives the status as a bound parameter,
    // so it carries no literal of its own — session.ts is the writer site
    // whose text actually contains the terminal values.
    writerSites: ['src/runtimes/agent/session.ts'],
  },
  {
    table: 'outbound_sends',
    statusColumn: 'status',
    vocabulary: ['intent', 'sent', 'failed'],
    vocabularySource: 'sql-check',
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/outbound-sends.ts'], // markFailed prepared statement
  },
  {
    table: 'scheduled_messages',
    statusColumn: 'status',
    vocabulary: ['pending', 'processing', 'sent', 'failed'],
    vocabularySource: 'literal', // DDL has no CHECK; values are scheduler.ts string literals
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/scheduler.ts'],
  },
  {
    table: 'fact_export_queue',
    statusColumn: 'status',
    vocabulary: ['pending', 'quarantined', 'exported'],
    vocabularySource: 'literal', // DDL has no CHECK; values are fact-export-queue.ts string literals
    terminalFailureValues: ['quarantined'],
    writerSites: ['src/runtimes/chat/enrichment/fact-export-queue.ts'],
  },
  {
    table: 'decryption_failures',
    statusColumn: null,
    vocabulary: [],
    // Failure-by-construction: every row IS failure evidence (an undecryptable
    // inbound message) — there is no status enum to enforce. terminalFailureValues
    // is therefore not a real status value, it's literally the table name.
    // HONESTY NOTE: this means the guard's check (3) — "the literal appears in
    // the writer site" — only proves this module's TEXT mentions
    // 'decryption_failures' (near-tautological: any module that inserts into
    // a table necessarily contains that table's own name somewhere). It does
    // NOT prove a failure row is actually written on decryption failure; the
    // real behavioral proof for that lives in tests/core/decryption-failures.test.ts.
    vocabularySource: 'literal',
    terminalFailureValues: ['decryption_failures'],
    writerSites: ['src/core/database.ts'], // storeDecryptionFailure()
  },
  {
    table: 'recovery_runs',
    statusColumn: 'status',
    vocabulary: ['started', 'completed', 'failed'],
    vocabularySource: 'literal', // DDL has no CHECK (migration 45 adds a bare TEXT column)
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/durability-recovery-evidence.ts'], // recordIncompleteRecoveryRun()
  },
  {
    table: 'enrichment_runs',
    statusColumn: 'error',
    // Free text (the caught error's .message) — there is no fixed failure
    // vocabulary to enumerate. terminalFailureValues is therefore not a real
    // status value, it's literally the table name (chosen over the near-vacuous
    // word "error", which would match almost any file).
    // HONESTY NOTE: this means the guard's check (3) only proves this module's
    // TEXT references 'enrichment_runs' — a much weaker claim than "the failure
    // write is proven to execute" (near-tautological: any module that inserts
    // into a table necessarily contains that table's own name somewhere). The
    // real behavioral proof that a failure row is written on cycle failure
    // lives in the Task 1-2 SQLite persistence tests
    // (tests/runtimes/chat/enrichment/poller.test.ts), not this declaration.
    vocabulary: [],
    vocabularySource: 'literal',
    terminalFailureValues: ['enrichment_runs'],
    writerSites: ['src/runtimes/chat/enrichment/poller.ts'], // outer catch — cycle-failure row
  },
  {
    table: 'beads',
    statusColumn: 'status',
    vocabulary: ['active', 'proposed', 'paused', 'completed', 'cancelled', 'failed'],
    vocabularySource: 'sql-check',
    terminalFailureValues: ['failed'],
    // 'failed' has NO truthful writerSites to declare (verified in this
    // worktree, not carried over from the census, which was wrong here):
    // `transition()` in beads.ts is the only function that ever writes
    // `beads.status`, and it is called with 'completed'/'cancelled'/'active'
    // only — never 'failed'. `update_bead` explicitly cannot change status.
    // Declaring beads.ts here anyway (the literal appears in TERMINAL /
    // BeadStatus, neither of which is a writer) would be exactly the
    // "literal survives in a comment/constant, not a writer" technicality
    // the guard's honesty note warns about. Left empty on purpose — see
    // TRACKED_UNWIRED_TERMINAL below, which is what makes this a DECLARED,
    // reviewed gap instead of a silent pass or a silent drop.
    writerSites: [],
  },
  {
    table: 'background_work',
    statusColumn: 'state',
    vocabulary: ['registered', 'running', 'completed', 'failed', 'orphaned'],
    vocabularySource: 'sql-check',
    // 'orphaned' is deliberately NOT terminal: it is the sweep's verdict that the
    // parent died, and such work can still finish and report (that is the whole
    // point of the ledger). Only 'failed' is terminal failure.
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/background-work-store.ts'], // completeBackgroundWork()
  },
  {
    table: 'work_results',
    statusColumn: 'delivery_state',
    vocabulary: ['pending', 'delivering', 'delivered', 'failed'],
    vocabularySource: 'sql-check',
    terminalFailureValues: ['failed'],
    writerSites: ['src/core/background-work-store.ts'], // releaseWorkResultDelivery(retryable=false)
  },
];

/**
 * The one owner-declared exception: a status-bearing table structurally exempt
 * from the writer-invariant check. Each entry MUST carry a non-empty reason and
 * issue (the guard enforces this; a bare reserved entry fails the guard).
 */
export const TRACKED_RESERVED: ReservedEntry[] = [
  {
    table: 'sweep_runs',
    reason: '0-ref reserved substrate table, no live sweep pipeline',
    issue: '#1789',
  },
];

/**
 * Declared exceptions for a LIVE status-bearing table (still classified in
 * KNOWN_STATUS_TABLES / REGISTRY) whose declared terminal-failure value has
 * NO production writer today. Distinct from `TRACKED_RESERVED`: a reserved
 * table is exempt entirely; an entry here exempts only the named
 * `terminalValue` on an otherwise normally-checked table — the table's other
 * terminal values (if any) still require a resolvable writer.
 *
 * This is the fail-closed complement to the guard's declaration-existence
 * check: an UNDECLARED writer-resolution failure is a violation (exit 1); a
 * DECLARED one (non-empty reason + issue, same rule as TRACKED_RESERVED) is a
 * reviewed, tracked gap that passes. Confirmed independently against this
 * worktree (not the census, which incorrectly claimed `update_bead` as the
 * writer): `update_bead` is status-protected (its Zod schema has no `status`
 * field and its own description says "Cannot change kind/owner/status");
 * `transition()` in beads.ts is the only function that writes `beads.status`,
 * and its three callers (`completeBead`/`cancelBead`/`approveProposal`) only
 * ever pass 'completed'/'cancelled'/'active'. No `fail_bead` tool exists.
 */
export const TRACKED_UNWIRED_TERMINAL: UnwiredTerminalEntry[] = [
  {
    table: 'beads',
    terminalValue: 'failed',
    reason:
      "terminal 'failed' declared (SQL CHECK schema.ts:10 + BeadStatus union + TERMINAL beads.ts:18) but NO production writer sets it — update_bead is status-protected, transition() callers are complete/cancel only; owner decision pending: wire a fail path or drop 'failed' from the vocabulary",
    issue: '#1789',
  },
];

/**
 * Every remaining table in `migratedSchemaSnapshot()` (src/core/database.ts),
 * classified as NOT status-bearing durability. Completeness over the MIGRATED
 * SNAPSHOT is total: this set plus `KNOWN_STATUS_TABLES` plus
 * `RESERVED_TABLES` must equal every migrated table, with no overlaps — the
 * guard's check (1) enforces both directions. (Completeness over every table
 * that EXISTS is a separate, wider claim covered by check 1b's discovery
 * scan against `SELF_PROVISIONED` + `DISCOVERY_EXCLUSIONS` below — this set
 * does not need to, and does not, mention those six self-provisioned tables.)
 */
export const NON_STATUS_TABLES: Set<string> = new Set([
  'access_list',
  'agent_token_events',
  'bead_entity_refs',
  'bead_events',
  'bead_triggers',
  'blocklist',
  'chat_aliases',
  'chats',
  'contacts',
  'control_messages',
  'entities',
  'entity_aliases',
  'entity_observations',
  'groups',
  'heal_reports',
  'inbound_disposition_links',
  'label_associations',
  'labels',
  'lid_mappings',
  'lid_mappings_history',
  'llm_attempts',
  'messages',
  'messages_fts',
  'messages_fts_config',
  'messages_fts_data',
  'messages_fts_docsize',
  'messages_fts_idx',
  'metrics_hourly',
  'operator_catchup_closure_witnesses',
  'pending_heal_reports',
  'pending_polls',
  'rate_limits',
  'reactions',
  'receipts',
  'recovery_plans',
  'schema_migrations',
  'turn_delivery_corroboration',
  'turn_terminal_records',
]);

/**
 * ANTI-DODGE justifications (guard check 2b). Every `NON_STATUS_TABLES` member
 * whose actual column names match `/status|state|error|outcome|failed/i` MUST
 * have a truthful one-line entry here, or the guard fails closed — a future
 * author cannot silently reclassify a status-bearing table as "not our
 * problem" by routing it into the non-status bucket.
 */
export const NON_STATUS_JUSTIFICATIONS: Record<string, string> = {
  access_list: "status ∈ {allowed,blocked,pending,seen} is an admission/access-control decision on a contact, not a durability write's completion outcome — 'blocked' and 'pending' are steady states, not failures, and no terminal-failure semantics apply.",
  bead_triggers: "status ∈ {active,paused,expired,cancelled} is the trigger DEFINITION's own admin/config lifecycle (like a cron job being enabled/disabled), not a write-attempt's outcome; each individual firing's success/failure is recorded in trigger_runs, a registered KNOWN_STATUS_TABLES entry with terminalFailureValues=['failed'].",
  heal_reports: "error_class/error_type/state belong to the self-heal circuit-breaker (BOT ERRORS) incident workflow, not the durability engine's write-completion path #1789 targets — its terminal-failure value 'escalated' already has a resolvable production writer (handleHealComplete, src/core/heal.ts), so this is a domain exclusion, not a reporting-capability gap.",
  pending_heal_reports: "error_class/state mirror heal_reports' single-flight queue-slot bookkeeping for the same self-heal subsystem; state='resolved' is written in production (src/runtimes/agent/runtime.ts) — same domain exclusion as heal_reports.",
  messages: "enrichment_error is a per-message denormalized cache of the last enrichment attempt's error text; the message row is content storage, not an operation-attempt whose own completion is asserted — the run-level terminal failure lives in enrichment_runs.error, a registered KNOWN_STATUS_TABLES entry.",
};

/**
 * Real, live tables created OUTSIDE the numbered migration registry by their
 * own self-managed `ensureXSchema(db)` function (`db.raw.exec('CREATE TABLE
 * IF NOT EXISTS ...')` called lazily, not wired into `MIGRATIONS` in
 * `src/core/database.ts`) — invisible to `migratedSchemaSnapshot()`, which
 * only replays that migration registry. Verified directly against this
 * worktree: each module below is read by the guard's discovery-scan
 * anti-dodge extension (check 1b), which also confirms none of their DDL
 * text matches the status-shaped-column regex today (so `justification` is
 * unset on all six; it becomes required the day one does).
 */
export const SELF_PROVISIONED: SelfProvisionedEntry[] = [
  {
    table: 'agent_fallback_state',
    module: 'src/runtimes/agent/fallback-state-db.ts',
    reason: 'singleton usage-limit fallback-state row; self-managed schema (ensureFallbackStateSchema), not a numbered global migration.',
  },
  {
    table: 'agent_handoff_artifacts',
    module: 'src/runtimes/agent/handoff-artifact.ts',
    reason: 'cross-harness handoff-artifact cache (distilled summary + seeded artifacts); self-managed schema (ensureHandoffArtifactSchema), an optimisation that never blocks a turn.',
  },
  {
    table: 'chat_model_preference',
    module: 'src/runtimes/agent/chat-preference-db.ts',
    reason: 'per-sender model/provider preference store; self-managed schema (ensureChatPreferenceSchema), not a numbered global migration.',
  },
  {
    table: 'command_surface_prefs',
    module: 'src/runtimes/agent/command-surface-prefs-db.ts',
    reason: 'per-sender command-surface preference store; self-managed schema (ensureCommandSurfacePrefsSchema), generalizes the chat-preference-db.ts convention.',
  },
  {
    table: 'pending_poll_decisions',
    module: 'src/fleet/routes/approvals.ts',
    reason: 'offline durable fallback queue for poll decisions when the fleet proxy returns 502 (v1.1 design D2(b)); created lazily inline at the write site, not a numbered global migration.',
  },
  {
    table: 'standby_notice',
    module: 'src/runtimes/agent/standby-notice.ts',
    reason: 'one-pending-notice-per-conversation stash for standby-provider handoff; self-managed schema (ensureStandbyNoticeSchema), not a numbered global migration.',
  },
];

/**
 * Table names the discovery scan (guard check 1b) WILL find via a
 * `CREATE TABLE` text occurrence, that are NOT real persisted tables — so a
 * hit needs an exclusion, not a `SELF_PROVISIONED` registration.
 */
export const DISCOVERY_EXCLUSIONS: DiscoveryExclusionEntry[] = [
  {
    table: 'outbound_sends_v26',
    reason: "migration-26 transient create->copy->rename artifact (src/core/database.ts:521-575): outbound_sends_v26 is CREATEd, populated from the old outbound_sends via INSERT...SELECT, then the old table is DROPped and this one RENAMEd to outbound_sends — it never exists as a persisted table under its own name, so it never appears in migratedSchemaSnapshot() and needs no SELF_PROVISIONED entry.",
  },
];

/** Derived: table names with a registered status-writer entry. */
export const KNOWN_STATUS_TABLES: Set<string> = new Set(REGISTRY.map((entry) => entry.table));

/** Derived: table names covered by the one declared reserved exception. */
export const RESERVED_TABLES: Set<string> = new Set(TRACKED_RESERVED.map((entry) => entry.table));

/** Derived: table names self-provisioned outside the migration registry. */
export const SELF_PROVISIONED_TABLES: Set<string> = new Set(SELF_PROVISIONED.map((entry) => entry.table));

/** Derived: table names excluded from the discovery scan (transient DDL artifacts). */
export const DISCOVERY_EXCLUSION_TABLES: Set<string> = new Set(DISCOVERY_EXCLUSIONS.map((entry) => entry.table));
