import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { forceEnsurePrivateDirectorySync, fsyncDirectory } from './private-fs.ts';
import { confineAlertContent, confineConversationScope } from './alert-evidence.ts';
import { redactText } from './redaction-text.ts';
import { asNonEmptyString } from './type-guards.ts';
import { systemClock } from './clock.ts';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type BotErrorsSeverity = 'critical' | 'error' | 'warning' | 'info';
export type BotErrorsEventType = 'alert' | 'clear' | 'observation';
export type BotErrorsEventKind = 'incident_alert' | 'incident_recovery' | 'observation';
export type BotErrorsRecoverability =
  | 'auto_recoverable'
  | 'operator_recoverable'
  | 'manual_relink_required'
  | 'manual_repair_required'
  | 'unrecoverable'
  | 'unknown';
export type BotErrorsFailureConfidence = 'suspected' | 'probable' | 'confirmed';
export type BotErrorsCriticalAssetKind =
  | 'whatsapp_linked_device'
  | 'whatsapp_auth_bond'
  | 'credential'
  | 'account_linkage'
  | 'bot_errors_delivery'
  | 'runtime_session';

export interface BotErrorsCriticalAssetDiagnostic {
  asset: {
    kind: BotErrorsCriticalAssetKind;
    instance: string;
    owner?: string;
    path?: string;
    fingerprint?: string;
  };
  failure: {
    code: string;
    domain: string;
    recoverability: BotErrorsRecoverability;
    confidence: BotErrorsFailureConfidence;
    operatorAction: string;
    clearRequirement: string;
  };
  evidenceRefs?: string[];
}

/**
 * Structured inputs for the dispatcher's per-cause hold on a
 * `health_body_degraded` alert (#2409). The dispatcher holds such an event
 * only when the bot reports WhatsApp connected AND every cause carries a
 * registered hold tier. It reads both from `diagnostics` or from the evidence
 * text, but #2386 confines the evidence text to a digest, so without these
 * fields every degraded event classifies as an outage and pages at once.
 *
 * Values are fixed cause codes and a boolean, never content, so they cross the
 * confinement boundary unchanged.
 */
export interface BotErrorsDegradationDiagnostics {
  degradationCauses?: readonly string[];
  whatsappConnected?: boolean;
}

export interface BotErrorsOutboxInput {
  eventType: BotErrorsEventType;
  instance: string;
  source: string;
  summary: string;
  evidence?: string;
  severity?: BotErrorsSeverity;
  criticalAsset?: BotErrorsCriticalAssetDiagnostic;
  /**
   * Reliability 4.3: true marks a re-NOTIFICATION of an unchanged open
   * condition (e.g. the health poller re-emitting a still-degraded instance
   * through its throttle). The dispatcher's flap detector skips renotify
   * events for trip counting — only the emitter knows re-emit vs fresh
   * occurrence, so the marker must ride the event. Omitted when false.
   */
  renotify?: boolean;
  /**
   * Raw conversation identifier for a fault that belongs to ONE conversation
   * (e.g. a turn rejected before dispatch). Never emitted: the builder
   * projects it to a bounded, non-reversible `conversationScope` digest, the
   * same way summary and evidence are confined (#2386). Confinement lives
   * here rather than at the call site so no emitter can ship a raw JID.
   *
   * The dispatcher keys incidents on machine|instance|source. Without this
   * field a second conversation failing under an already-open incident is
   * filed as a duplicate and produces no operator signal at all.
   *
   * Omitted when the emitter has no conversation, which keeps the emitted
   * event shape unchanged for every existing source.
   */
  conversationKey?: string;
  /**
   * Cause codes and the connected flag of a degraded instance; see
   * {@link BotErrorsDegradationDiagnostics}. Validated in the builder and
   * merged into `diagnostics`. Omitted for every other source, which keeps
   * their emitted shape unchanged.
   */
  degradationDiagnostics?: BotErrorsDegradationDiagnostics;
}

export interface BotErrorsOutboxWrite {
  eventId: string;
  path: string;
}

interface BotErrorsEnvelopeFields {
  schemaVersion: 2;
  eventKind: BotErrorsEventKind;
  eventType: BotErrorsEventType;
  severity: BotErrorsSeverity;
}

export { redactText as redactBotErrorsText } from './redaction-text.ts';

// Intentionally distinct from transport/connection.ts's same-purpose redactor
// (and deliberately renamed away from its old shared name `redactDiagnosticValue`
// to remove the confusing collision). The split is safe: this outbox path only
// ever receives the type-locked `BotErrorsCriticalAssetDiagnostic` (fixed benign
// keys — `fingerprint` is a SHA-256 hash, `path` is covered by redactText's
// credential-path rule) plus pre-stringified strings. No sensitive-keyed object,
// raw Error instance, or deeply-nested attacker-shaped value can reach here, so
// connection.ts's key-sensitivity, depth-cap, and Error-instance handling are
// unreachable. `redactText` (secret-shape-based) is sufficient and complete for
// this input — same redaction output, no behavior change.
function redactOutboxValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactOutboxValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactOutboxValue(item)]),
    );
  }
  return value;
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unknown';
}

function nowIso(): string {
  return new Date().toISOString();
}

function runningUnderVitest(): boolean {
  // env-allowed: test-runner detection; must not read config (lib ring / eval-order)
  return process.env['VITEST'] === 'true'
    // env-allowed: test-runner detection; must not read config (lib ring / eval-order)
    || process.env['VITEST_POOL_ID'] !== undefined
    // env-allowed: test-runner detection; must not read config (lib ring / eval-order)
    || process.env['VITEST_WORKER_ID'] !== undefined;
}

function vitestStateDir(): string | null {
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  if (process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'] === '1' || !runningUnderVitest()) {
    return null;
  }

  // env-allowed: test-runner detection; must not read config (lib ring / eval-order)
  const workerId = safeSegment(process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? 'main');
  return join(tmpdir(), 'whatsoup-vitest-bot-errors', workerId, String(process.pid), 'state');
}

// ENV-LATE BY DESIGN (#2192 slice 3c — do not migrate to config). The
// explicit-override → vitest-isolate → homedir-default chain below is
// load-bearing on ABSENCE: if config published BOT_ERRORS_STATE_DIR /
// BOT_ERRORS_OUTBOX_DIR unconditionally, stateDir() would stop isolating test
// traffic (the #2658/#2887 CI-drift class) and outboxPolicy() would stamp
// every event 'explicit-*', breaking the dispatcher's test-provenance
// backstop. Test-runner detection is lib-level logic; the deploy layer
// (systemd Environment=, launchd plists, Python installers) is the
// cross-process SSOT for these dirs — config would be a third source.
function stateDir(): string {
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  return process.env['BOT_ERRORS_STATE_DIR'] ?? vitestStateDir() ?? join(homedir(), '.local', 'state', 'bot-errors');
}

// BOT_ERRORS_WRITEFAIL_DIR: explicit-override-only escape hatch; the default
// derives from stateDir(), so there is no config value to add (env-late).
function writefailDirs(): string[] {
  const candidates = [
    // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
    process.env['BOT_ERRORS_WRITEFAIL_DIR'],
    join(stateDir(), 'writefail'),
    join(homedir(), '.bot-errors-writefail'),
    // env-allowed: TMPDIR publish-back pattern; config writes it at load, env is the lib-side channel
    join(process.env['TMPDIR'] ?? '/tmp', 'bot-errors-writefail'),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

export function botErrorsOutboxDir(): string {
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  return process.env['BOT_ERRORS_OUTBOX_DIR'] ?? join(stateDir(), 'outbox');
}

/**
 * Strong test-runner signals, mirroring `STRONG_TEST_SIGNAL_KEYS` in
 * `deploy/scripts/bot-errors-emit.py` and `deploy/hooks/post-tool-use-log.mjs`.
 *
 * `VITEST_POOL_ID` is present here but absent from the two sibling producers
 * because `runningUnderVitest()` above already treats it as a vitest signal for
 * *routing*. Omitting it would let a worker that sets only `VITEST_POOL_ID`
 * route into the isolated test state tree while still reporting `test: false` —
 * the exact split this stamp exists to prevent. The list is therefore a strict
 * superset, never a subset, of the shared four.
 */
const STRONG_TEST_SIGNAL_KEYS = [
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'JEST_WORKER_ID',
  'PYTEST_CURRENT_TEST',
] as const;

function envValue(key: string): string | undefined {
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  return asNonEmptyString(process.env[key]);
}

function strongTestSignals(): string[] {
  return STRONG_TEST_SIGNAL_KEYS.filter((key) => envValue(key) !== undefined);
}

function provenanceSignals(): string[] {
  const signals = strongTestSignals();
  // env-allowed: test-runner detection; must not read config (lib ring / eval-order)
  if ((process.env['NODE_ENV'] ?? '').trim().toLowerCase() === 'test') signals.push('NODE_ENV');
  return [...new Set(signals)].sort();
}

/**
 * Which branch of `stateDir()` / `botErrorsOutboxDir()` actually decided this
 * process's queue. Values match the `policy` strings emitted by the Python and
 * hook producers so a dispatcher-side audit reads one vocabulary.
 *
 * There is no `test-redirect` here: that policy belongs to the sibling
 * producers, which re-point an already-live path when strong signals are
 * present. This module reaches the same end state earlier, via
 * `vitestStateDir()`, and its escape hatch is `BOT_ERRORS_ALLOW_LIVE_IN_TESTS`.
 */
function outboxPolicy(): 'explicit-outbox' | 'explicit-state' | 'test-default' | 'default' {
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  if (process.env['BOT_ERRORS_OUTBOX_DIR'] !== undefined) return 'explicit-outbox';
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  if (process.env['BOT_ERRORS_STATE_DIR'] !== undefined) return 'explicit-state';
  if (vitestStateDir() !== null) return 'test-default';
  return 'default';
}

/**
 * Producer provenance for the BOT ERRORS dispatcher's test-traffic backstop
 * (`is_test_provenance_event` in `deploy/scripts/bot-errors-dispatcher.py`,
 * which screens on `runtime.provenance.test === true`).
 *
 * Until this existed, TypeScript was the only one of the repo's event builders
 * that emitted no provenance, so TypeScript-shaped verifier and falsifier
 * traffic reached the dispatcher indistinguishable from a genuine incident.
 *
 * `resolvedOutbox` intentionally repeats `diagnostics.queue`: both sibling
 * producers carry it inside provenance, and a provenance record that cannot be
 * audited without cross-referencing a second branch of the event is worth less
 * than one duplicated path field.
 *
 * `BOT_ERRORS_ALLOW_LIVE_IN_TESTS` deliberately does NOT clear `test`. That
 * hatch governs routing — it sends a runner process's events to the live queue
 * instead of the sandbox — and attestation must not follow it: a runner process
 * writing to the live queue is exactly the combination the dispatcher backstop
 * exists to refuse. This does change behaviour for that hatch: such an event
 * previously reached delivery and now reaches suppressed audit state.
 *
 * Not covered: the legacy fallback in `emit-alert.ts`, which spawns a helper
 * with raw CLI arguments when the outbox write throws. It builds no event, so
 * it carries no provenance and cannot reach the dispatcher screen at all.
 */
export function botErrorsRuntimeProvenance(): {
  producer: string;
  test: boolean;
  signals: string[];
  strongSignals: string[];
  outboxPolicy: string;
  liveOutboxRedirected: boolean;
  resolvedOutbox: string;
} {
  const strongSignals = strongTestSignals();
  const policy = outboxPolicy();
  return {
    producer: 'typescript-outbox',
    test: strongSignals.length > 0,
    signals: provenanceSignals(),
    strongSignals,
    outboxPolicy: policy,
    // True exactly when the vitest state tree diverted this process off the
    // live home-based default. Derivable from `outboxPolicy` today; carried
    // explicitly because the sibling producers do, and a consumer should not
    // have to know each producer's policy vocabulary to answer "was this
    // steered away from the live queue?".
    liveOutboxRedirected: policy === 'test-default',
    resolvedOutbox: botErrorsOutboxDir(),
  };
}

function writeFileDurable(path: string, payload: string | Uint8Array): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordBotErrorsWritefail(
  event: Record<string, unknown>,
  err: unknown,
  target: string,
): string | null {
  const reason = redactText(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const eventId = typeof event.id === 'string' ? event.id : 'unknown';
  const instance = typeof event.instance === 'string' ? event.instance : 'unknown';
  const fileName = `${writefailStamp()}.${safeSegment(instance)}.${safeSegment(eventId)}.writefail`;
  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: nowIso(),
    failedTarget: redactText(target),
    reason,
    emitPid: process.pid,
    event: redactOutboxValue(event),
  };
  return publishWritefailRecord(fileName, `${JSON.stringify(breadcrumb, null, 2)}\n`);
}

function writefailStamp(): string {
  return nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Durably publish one record into the first writable writefail directory.
 * Shared by the write-failure breadcrumb and the temp-sweep breadcrumbs so
 * every record takes the same private-dir, O_EXCL temp, rename, fsync path.
 */
function publishWritefailRecord(fileName: string, payload: string): string | null {
  for (const base of writefailDirs()) {
    const finalPath = join(base, fileName);
    const tmpPath = join(base, `.${fileName}.${process.pid}.tmp`);
    try {
      forceEnsurePrivateDirectorySync(base, 'bot-errors private directory');
      writeFileDurable(tmpPath, payload);
      renameSync(tmpPath, finalPath);
      chmodSync(finalPath, 0o600);
      fsyncDirectory(base);
      return finalPath;
    } catch {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Try the next fallback directory.
      }
    }
  }

  return null;
}

// Issue #2386: relevantEnvKeys(), logHints(), shellSingleQuote(),
// logPredicateQuote(), hostPlatform(), and hostRelease() were removed.
// They produced runtime environment keys and operator log-hint commands
// that embedded instance names, paths, and host identifiers — exactly the
// metadata the evidence boundary now strips. The dispatcher can reconstruct
// operator hints from the bounded event fields (instance, source).

function newBotErrorsEnvelope(eventType: BotErrorsEventType, severity: BotErrorsSeverity): BotErrorsEnvelopeFields {
  if (eventType === 'alert' && ['critical', 'error', 'warning'].includes(severity)) {
    return { schemaVersion: 2, eventKind: 'incident_alert', eventType: 'alert', severity };
  }
  // Preserve the public alert API's historical informational-notice spelling
  // without persisting its ambiguous v1-shaped pair.
  if (eventType === 'alert' && severity === 'info') {
    return { schemaVersion: 2, eventKind: 'observation', eventType: 'observation', severity: 'info' };
  }
  if (eventType === 'clear' && severity === 'info') {
    return { schemaVersion: 2, eventKind: 'incident_recovery', eventType: 'clear', severity: 'info' };
  }
  if (eventType === 'observation' && severity === 'info') {
    return { schemaVersion: 2, eventKind: 'observation', eventType: 'observation', severity: 'info' };
  }
  throw new Error('invalid bot errors envelope');
}

// Same token shape the dispatcher accepts (_DEGRADATION_CAUSE_TOKEN_RE), with a
// length bound. The cap is above the registry's cause count, so a valid vector
// is never cut.
const DEGRADATION_CAUSE_TOKEN_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DEGRADATION_CAUSES = 64;

/**
 * Keep only well-formed degradation diagnostics. A cause vector that is empty,
 * oversized or holds a non-code token is dropped whole rather than filtered:
 * a partial vector could hold a degradation whose dropped cause should page.
 * Without the vector the dispatcher classifies the event as an outage, which
 * is the visible side.
 *
 * This bounds the shape, not registry membership: the outbox is in the
 * deployer's TS-only import closure, so it cannot read the registry JSON. The
 * one caller, the health poller, sends only registry codes or `unrecognized`.
 */
function boundedDegradationDiagnostics(
  value: BotErrorsDegradationDiagnostics | undefined,
): { degradationCauses?: string[]; whatsappConnected?: boolean } {
  if (!value) return {};
  const causes = value.degradationCauses;
  const validCauses = Array.isArray(causes)
    && causes.length > 0
    && causes.length <= MAX_DEGRADATION_CAUSES
    && causes.every((cause) => typeof cause === 'string' && DEGRADATION_CAUSE_TOKEN_RE.test(cause));
  return {
    ...(validCauses ? { degradationCauses: [...new Set(causes)] } : {}),
    ...(typeof value.whatsappConnected === 'boolean' ? { whatsappConnected: value.whatsappConnected } : {}),
  };
}

export function buildBotErrorsEvent(input: BotErrorsOutboxInput, eventId = randomUUID(), createdAt = nowIso()) {
  const instance = input.instance.trim() || 'unknown';
  const source = input.source.trim() || 'unknown';
  const severity = input.severity ?? (input.eventType === 'alert' ? 'critical' : 'info');
  const envelope = newBotErrorsEnvelope(input.eventType, severity);
  const rawSummary = input.summary.trim() || `${envelope.eventType} event from ${source}`;
  const rawEvidence = input.evidence?.trim() ?? '';
  const criticalAsset = input.criticalAsset
    ? redactOutboxValue(input.criticalAsset) as BotErrorsCriticalAssetDiagnostic
    : null;

  // Issue #2386: confine evidence and summary to bounded metadata-only
  // fields at the emission boundary. Raw prose, exception text, provider
  // output, identifiers, and paths are replaced with failure-class hints,
  // length, and a non-reversible correlation digest.
  const confinedSummary = confineAlertContent('summary', rawSummary);
  const confinedEvidence = confineAlertContent('evidence', rawEvidence);
  const conversationScope = confineConversationScope(input.conversationKey);

  return {
    ...envelope,
    id: eventId,
    createdAt,
    instance,
    source,
    // Additive, absent-by-default (back-compat shape): present only when the
    // emitter explicitly marks a re-notification. See BotErrorsOutboxInput.
    ...(input.renotify === true ? { renotify: true } : {}),
    summary: confinedSummary,
    evidence: confinedEvidence,
    // Additive, absent-by-default (back-compat shape): a bounded digest of the
    // conversation, present only for per-conversation faults. Never the raw
    // identifier — see BotErrorsOutboxInput.conversationKey.
    ...(conversationScope !== null ? { conversationScope } : {}),
    // Issue #2386: strip absolute paths and raw process arguments. Keep
    // only bounded process metadata: pid, ppid, and node version.
    process: {
      pid: process.pid,
      ppid: process.ppid,
      argvCount: process.argv.length,
      node: process.version,
    },
    runtime: {
      // Systemd per-invocation identity — set by the service manager for THIS
      // process run; cannot be resolved at config load (env-late by design).
      // env-allowed: systemd per-invocation identity; cannot resolve at config load
      invocationId: process.env['INVOCATION_ID'] ?? null,
      // env-allowed: systemd per-invocation identity; cannot resolve at config load
      systemdExecPid: process.env['SYSTEMD_EXEC_PID'] ?? null,
      provenance: botErrorsRuntimeProvenance(),
    },
    diagnostics: {
      queue: botErrorsOutboxDir(),
      // Additive, absent-by-default: only a degraded-health alert carries
      // these. See BotErrorsDegradationDiagnostics.
      ...boundedDegradationDiagnostics(input.degradationDiagnostics),
    },
    delivery: {
      attempts: 0,
      status: 'queued',
      nextAttemptAtEpoch: 0,
      lastError: null,
    },
    ...(criticalAsset ? { criticalAsset } : {}),
  };
}

export function writeBotErrorsEvent(input: BotErrorsOutboxInput): BotErrorsOutboxWrite {
  const outbox = botErrorsOutboxDir();
  // Fail closed: when the outbox dir is NOT explicitly set and we're under
  // vitest, the resolved path MUST be under tmpdir — never the repo root
  // or homedir. Prevents the recurring src/main.ts sha256 drift caused by
  // a sandbox fallback writing into the working tree (#2658, #2887 CI).
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  if (process.env['BOT_ERRORS_OUTBOX_DIR'] === undefined
      // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
      && process.env['BOT_ERRORS_STATE_DIR'] === undefined
      // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
      && process.env['BOT_ERRORS_TEST_ISOLATED'] === '1'
      && runningUnderVitest()) {
    const resolved = join(outbox, 'guard');
    if (!resolved.startsWith(tmpdir())) {
      throw new Error(
        `writeBotErrorsEvent under vitest would write outside tmpdir: ${outbox}`,
      );
    }
  }
  const event = buildBotErrorsEvent(input);
  const fileName = outboxEventFileName(event);
  const finalPath = join(outbox, fileName);
  const tmpPath = join(outbox, `.${fileName}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(event, null, 2)}\n`;

  try {
    forceEnsurePrivateDirectorySync(outbox, 'bot-errors private directory');
    writeFileDurable(tmpPath, payload);
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o600);
    fsyncDirectory(dirname(finalPath));
  } catch (err) {
    recordBotErrorsWritefail(event, err, finalPath);
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; the caller handles the write failure.
    }
    throw err;
  }

  // After publication, so the fresh alert never waits on or fails with the sweep.
  maybeSweepBotErrorsOutboxTemps(event.instance);
  return { eventId: event.id, path: finalPath };
}

/**
 * `<created>.<instance>.<source>.<id>.json`. Milliseconds are preserved as a
 * `_NNN` suffix so new names sort *after* old same-second names, which ended
 * at `...SSZ.<instance>`, and stay lexical within their second.
 */
function outboxEventFileName(event: { createdAt: string; instance: string; source: string; id: string }): string {
  const fractionalTimestamp = event.createdAt.match(/^(.*)\.(\d{3})Z$/);
  const created = fractionalTimestamp
    ? `${fractionalTimestamp[1]!.replace(/[-:]/g, '')}Z_${fractionalTimestamp[2]}`
    : event.createdAt.replace(/[-:]/g, '');
  return `${created}.${safeSegment(event.instance)}.${safeSegment(event.source)}.${event.id}.json`;
}

// ---------------------------------------------------------------------------
// Crash-orphan temp recovery
//
// writeBotErrorsEvent publishes through `.<fileName>.<pid>.tmp` → rename. A
// producer killed between the durable temp write and the rename leaves the
// ONLY copy of the event in a hidden temp that the dispatcher never scans (it
// reads non-hidden `*.json` and reconciles only its own `.durable-json.*.tmp`
// names). This sweep closes that crash window for the TypeScript producer.
//
// Scope: only outbox entries matching THIS writer's temp shape — a
// fractional-timestamp final name with a UUID id, then a positive pid, and
// optionally a `.c<N>` claim segment (a sweep's claim) — plus this sweep's own
// `.<final>.<pid>.promote.tmp` scratch files, which are only ever retired
// after the TTL. The post-tool-use hook's temps (no `_NNN`, non-UUID ids), the
// Python producers' durable-json temps, and writefail-dir temps never match.
//
// A temp is a candidate only when its mtime is older than the grace period AND
// its pid is dead, or alive but started after the temp's mtime (pid reuse). If
// a live pid's start time cannot be determined, the temp is left alone. That
// trades recovery for safety: an in-flight write is never stolen, and the
// temp is reconsidered on every later sweep, so it is recovered once that pid
// exits.
//
// A candidate is promoted only when it is a complete, schema-valid event whose
// envelope and file name agree, nothing is published under that name or id
// yet, and it is inside the TTL. Promotion is bound to the validated object:
// the temp is claimed by an atomic rename to a claim name unique to this
// process and claim (the single-winner step across processes), the claim must
// still be the validated inode, and the bytes that were read and validated,
// never the file at a path, are published through the writer's durable path
// (see promoteValidatedOutboxTemp, including what happens when publishing
// throws). Otherwise it is retired: a
// content-free `.tempretire` breadcrumb in the writefail dir, then unlink of
// that same object (dev/ino re-checked). When no breadcrumb can be written the temp is kept (the only
// record of it) and counted retire-deferred; a later sweep retries it. torn /
// schema-invalid / unsafe-content / stale-ttl retirements lose an alert, so any
// sweep with one emits a single summary observation; already-published
// retirements lose nothing and stay breadcrumb-only. A retire-deferred torn /
// schema-invalid / unsafe-content / stale-ttl temp also triggers the summary, but only the first time this
// process defers it: it is remembered (by device, inode and name) in a set
// capped at OUTBOX_TEMP_DEFERRED_REPORT_CAP entries, so a temp that stays
// deferred pages once per process start, not once per sweep. After a sweep
// whose directory scan completed, the set keeps only the keys deferred in
// that sweep, so entries for temps that vanished cannot fill it. A deferred
// already-published temp lost nothing: it counts in retire-deferred but never
// triggers the summary, which asserts a confirmed loss. A temp whose
// processing throws is counted as a sweep error and the scan continues; that
// count rides along in a summary but does not trigger one.
//
// A candidate whose object a swap destroys is not published. That is either
// a validated temp destroyed before its claim (the claim is a different inode
// and the held descriptor's link count is 0), or a temp swapped between the
// lstat and the open whose original is nowhere in the outbox any more (its
// id then comes from its file name; the contents were never read). A third
// kind: a failed publish whose restore finds its own claim removed by another
// sweep's early sibling cleanup, with no name left and the event not
// published by that other sweep either (restore-unheld). Each is
// recorded as a loss: a `.templost` breadcrumb in the writefail dir naming
// its event id, and a summary carrying lost-after-validation (every kind) and
// up to OUTBOX_TEMP_SUMMARY_LOST_IDS_MAX lost-event ids. A peer's claim, or a
// path that simply emptied, is not a loss: the original is still in the
// outbox, or its fate is unknown, so it stays a plain sweep error.
//
// Right after the claim, and again after the publish, other names for the
// same final name that are still the claimed inode (a hard-linked sibling a
// failed restore unlink left behind) are unlinked, so neither another sweep
// nor a later one can publish them again. A name this sweep unlinked that is
// still ahead in its listing is not counted as an error when its lstat then
// finds nothing. A claim restore links the temp name back before it unlinks
// the claim and only then restores the old mtime, so two names for one
// object never both sit past the grace period.
//
// The read opens with O_NOFOLLOW | O_NONBLOCK and then fstats the descriptor:
// a symlink, FIFO or other non-regular file, or a different regular file (the
// device and inode must equal the lstat's), swapped in after the lstat is
// refused (a sweep error, and a loss as above when the original is gone)
// without the open ever blocking.
//
// The pid probe runs at most once per distinct pid per sweep, so the macOS
// `ps` spawn costs one call per live pid, not one per temp.
//
// Known limit: the sweep runs from this writer, so an orphan waits for the
// next TypeScript outbox write on the same host.
// ---------------------------------------------------------------------------

/** A temp younger than this may still belong to a write in progress. */
const OUTBOX_TEMP_GRACE_MS = 10 * 60 * 1000;
/** Beyond this age a promoted alert would page stale news; retire it instead. */
const OUTBOX_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
/** The first write in a process always sweeps; later writes at most this often. */
const OUTBOX_TEMP_SWEEP_INTERVAL_MS = 60_000;
/** Events are a few KiB; anything this large is not a temp this writer produced. */
const OUTBOX_TEMP_MAX_BYTES = 1024 * 1024;
/**
 * How many distinct deferred temps one process remembers as already reported.
 * Retiring or promoting a temp frees its entry, and so does a completed scan
 * that no longer defers it. Once full, further deferred temps stop triggering
 * a summary on their own (their count still rides in any summary) until
 * entries free up or the process restarts: this bounds both memory and paging
 * when breadcrumb writes are down for a long time.
 */
const OUTBOX_TEMP_DEFERRED_REPORT_CAP = 1024;
const OUTBOX_TEMP_SWEEP_SOURCE = 'bot-errors-outbox-temp-sweep';
/** Linux reports /proc starttime in USER_HZ ticks, which the kernel ABI fixes at 100. */
const LINUX_USER_HZ = 100;
const PS_TIMEOUT_MS = 1_000;

const OUTBOX_FINAL_NAME_RE =
  /^\d{8}T\d{6}Z_\d{3}\.[A-Za-z0-9_.:-]+\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
// `.<final>.<pid>.tmp` (the writer) or `.<final>.<pid>.c<N>.tmp` (a sweep's
// claim); the claim segment is non-capturing, so [1] is the final name and [2]
// the pid either way.
const OUTBOX_TEMP_NAME_RE = /^\.(.+)\.([1-9]\d{0,9})(?:\.c[1-9]\d{0,9})?\.tmp$/;
// `.<final>.<pid>.promote.tmp`: a sweep's publish scratch file.
const OUTBOX_PROMOTE_SCRATCH_NAME_RE = /^\.(.+)\.([1-9]\d{0,9})\.promote\.tmp$/;
// `.<final>.<pid>.promote.intent`: a promotion's intent (see resolvePromoteIntent).
// It matches neither the temp, scratch or final shapes nor the Python
// writers' `.durable-json.*.tmp`, and the dispatcher reads only `*.json`.
const OUTBOX_PROMOTE_INTENT_NAME_RE = /^\.(.+)\.([1-9]\d{0,9})\.promote\.intent$/;
/** A claim name search never needs more than a few tries; bound it anyway. */
const OUTBOX_TEMP_CLAIM_NAME_ATTEMPTS = 1_000;
const KNOWN_ENVELOPES = new Set([
  'incident_alert|alert|critical',
  'incident_alert|alert|error',
  'incident_alert|alert|warning',
  'observation|observation|info',
  'incident_recovery|clear|info',
]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type OutboxTempProcessState = { alive: false } | { alive: true; startedAtMs: number | null };
export type OutboxTempRetireClass = 'torn' | 'schema-invalid' | 'unsafe-content' | 'stale-ttl' | 'already-published';

export interface OutboxTempSweepResult {
  scanned: number;
  promoted: number;
  skipped: number;
  /**
   * Failures: an unreadable outbox, or a temp whose processing threw (left in
   * place for a later sweep unless a concurrent sweep already took it).
   */
  errors: number;
  retired: Record<OutboxTempRetireClass, number>;
  /** Temps that should be retired but were kept because no breadcrumb could be written. */
  retireDeferred: number;
  /**
   * Of those, the torn / schema-invalid / unsafe-content / stale-ttl ones this process had not
   * reported before; any triggers the summary. Already-published never counts.
   */
  retireDeferredNew: number;
  /** `.promote.tmp` scratch files older than the TTL retired with a breadcrumb. */
  scratchRetired: number;
  /**
   * Candidates whose file a swap destroyed, between validation and the claim
   * (link count 0) or between the lstat and the open (original gone from the
   * outbox): lost, reported by event id.
   */
  lostAfterValidation: number;
  lostEventIds: string[];
  summaryEmitted: boolean;
}

/**
 * A swap replaced the candidate at the temp path (before the claim, or
 * between the lstat and the open) and no name holds it any more: the event
 * is lost. Carries the event id so the sweep can count and name it.
 */
class OutboxTempLostAfterValidationError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super('outbox temp was destroyed by a swap before its claim');
    this.eventId = eventId;
  }
}

/**
 * The open found a different object at the temp path than the lstat checked
 * (another regular file, or a non-regular file). A symlink is refused by the
 * open itself (ELOOP under O_NOFOLLOW).
 */
class OutboxTempSwappedAtOpenError extends Error {}

/** Event ids named in one summary; the count is always complete. */
const OUTBOX_TEMP_SUMMARY_LOST_IDS_MAX = 10;

interface PublishedOutboxNames {
  names: Set<string>;
  ids: Set<string>;
}

let outboxTempProcessProbe: (pid: number) => OutboxTempProcessState = probeOutboxTempProcess;
let outboxTempSweepInFlight = false;
let lastOutboxTempSweepAtMs: number | null = null;
/** Deferred temps already reported by this process; see OUTBOX_TEMP_DEFERRED_REPORT_CAP. */
const reportedDeferredOutboxTemps = new Set<string>();
let deferredReportCap = OUTBOX_TEMP_DEFERRED_REPORT_CAP;
let outboxTempBeforePromoteHook: ((tempPath: string) => void) | null = null;
let outboxTempAfterPublishHook: ((finalPath: string) => void) | null = null;
let outboxTempScratchWriteHook: ((scratchPath: string) => void) | null = null;
let outboxTempRestoreLinkedHook: ((tempPath: string, claimPath: string) => void) | null = null;
let outboxTempIntentWriteHook: ((intentPath: string) => void) | null = null;
let outboxTempBeforeFinalRenameHook: ((finalPath: string) => void) | null = null;
/** Per-process claim counter; see claimOutboxTempName. */
let outboxTempClaimCounter = 0;

/**
 * Test seam: replace the pid liveness / start-time probe so candidate rules
 * can be exercised without real processes. Pass null to restore the default.
 */
export function setBotErrorsOutboxTempProcessProbeForTests(
  probe: ((pid: number) => OutboxTempProcessState) | null,
): void {
  outboxTempProcessProbe = probe ?? probeOutboxTempProcess;
}

/**
 * Test seam: lower the reported-deferred-temp cap so the full-set rules can
 * be exercised without creating 1024 temps. Pass null to restore the default.
 */
export function setBotErrorsOutboxTempDeferredReportCapForTests(cap: number | null): void {
  deferredReportCap = cap ?? OUTBOX_TEMP_DEFERRED_REPORT_CAP;
}

/**
 * Test seam: run `hook(tempPath)` after a temp was read and validated and
 * before it is published, to exercise a swap in that window. Pass null to
 * remove it.
 */
export function setBotErrorsOutboxTempBeforePromoteHookForTests(
  hook: ((tempPath: string) => void) | null,
): void {
  outboxTempBeforePromoteHook = hook;
}

/**
 * Test seam: run `hook(finalPath)` right after a promotion's final rename and
 * before the steps that follow it (chmod, directory fsync, claim unlink), to
 * exercise a throw after publication. Pass null to remove it.
 */
export function setBotErrorsOutboxTempAfterPublishHookForTests(
  hook: ((finalPath: string) => void) | null,
): void {
  outboxTempAfterPublishHook = hook;
}

/**
 * Test seam: run `hook(scratchPath)` after a promotion's scratch file was
 * created and before its bytes are written, to exercise a write failure (as
 * ENOSPC or EIO) on a file this sweep created. Pass null to remove it.
 */
export function setBotErrorsOutboxTempScratchWriteHookForTests(
  hook: ((scratchPath: string) => void) | null,
): void {
  outboxTempScratchWriteHook = hook;
}

/**
 * Test seam: run `hook(tempPath, claimPath)` during a claim restore, right
 * after the validated file is linked back at the temp path and before the
 * claim name is removed, when both names exist. Pass null to remove it.
 */
export function setBotErrorsOutboxTempRestoreLinkedHookForTests(
  hook: ((tempPath: string, claimPath: string) => void) | null,
): void {
  outboxTempRestoreLinkedHook = hook;
}

/**
 * Test seam: run `hook(intentPath)` after a promotion's intent file was
 * created and before its bytes are written, to exercise a write failure on
 * a file this sweep created. Pass null to remove it.
 */
export function setBotErrorsOutboxTempIntentWriteHookForTests(
  hook: ((intentPath: string) => void) | null,
): void {
  outboxTempIntentWriteHook = hook;
}

/**
 * Test seam: run `hook(finalPath)` once the promotion intent is durable and
 * before the final rename: the first crash point the intent covers. Pass
 * null to remove it.
 */
export function setBotErrorsOutboxTempBeforeFinalRenameHookForTests(
  hook: ((finalPath: string) => void) | null,
): void {
  outboxTempBeforeFinalRenameHook = hook;
}

/** Is `pid` alive, and if so when did it start (epoch ms, null when unknown)? */
export function probeOutboxTempProcess(pid: number): OutboxTempProcessState {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return { alive: false };
    // EPERM means it exists under another uid; anything else is unknown.
    // Either way, treat it as alive.
  }
  return { alive: true, startedAtMs: processStartedAtMs(pid) };
}

function processStartedAtMs(pid: number): number | null {
  try {
    if (process.platform === 'linux') return linuxProcessStartedAtMs(pid);
    if (process.platform === 'darwin') return darwinProcessStartedAtMs(pid);
  } catch {
    // Deliberately: an unknown start time returns null, and the caller skips the temp.
  }
  return null;
}

// Boot time has one-second resolution and is floored, which alone reads early
// ("started before the temp", the safe direction). But the kernel derives
// btime from the current wall clock minus uptime, so a forward wall-clock step
// (settimeofday, an NTP step on a host without an RTC) moves every derived
// start time forward by the size of the step. A live writer whose temp predates
// the step can then read as a reused pid. Only a writer frozen past the grace
// period (SIGSTOP, cgroup freezer) keeps a temp that long, so the exposure is
// small, but the result is not guaranteed early.
function linuxProcessStartedAtMs(pid: number): number | null {
  // The caller already dispatches on platform; the local guard keeps the /proc
  // reads Linux-only by construction.
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after "(comm)" start at field 3 (state); starttime is field 22.
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    const bootTime = /^btime\s+(\d+)\s*$/m.exec(readFileSync('/proc/stat', 'utf8'));
    if (!Number.isFinite(startTicks) || !bootTime) return null;
    return Number(bootTime[1]) * 1000 + (startTicks * 1000) / LINUX_USER_HZ;
  }
  return null;
}

// `lstart` is local wall time truncated to the second, so the result can only
// be early — the safe direction. A DST fall-back hour is ambiguous.
function darwinProcessStartedAtMs(pid: number): number | null {
  const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    // ps must render lstart in the same TZ this process parses it in, in the C
    // locale. Allowlisted env only: TZ (when set) and the locale.
    env: {
      LC_ALL: 'C',
      LANG: 'C',
      // env-allowed: child-process TZ passthrough so ps and Date agree; lib cannot import config (ring rule)
      ...(process.env['TZ'] !== undefined ? { TZ: process.env['TZ'] } : {}),
    },
  });
  const match = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(out);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  const startedAtMs = new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function maybeSweepBotErrorsOutboxTemps(instance: string): void {
  // The whole step, throttle included, sits inside the try: the event is
  // already published, so nothing here may throw into the alert path.
  try {
    if (outboxTempSweepInFlight) return;
    const nowMs = systemClock.now();
    if (lastOutboxTempSweepAtMs !== null && nowMs - lastOutboxTempSweepAtMs < OUTBOX_TEMP_SWEEP_INTERVAL_MS) return;
    lastOutboxTempSweepAtMs = nowMs;
    sweepBotErrorsOutboxTemps({ summaryInstance: instance });
  } catch {
    // Deliberately: a sweep failure must never throw into the alert path that called it.
  }
}

/**
 * Recover or retire crash-orphaned temps in the configured outbox. Never
 * throws; per-temp failures are counted in `errors` and the scan continues.
 * Temps that could not get a breadcrumb are kept and counted in
 * `retireDeferred`; the lost-alert ones (not already-published) this process
 * has not reported before are counted in `retireDeferredNew` and trigger the
 * summary. A call made while a sweep is
 * already running (the summary event's own write) is a no-op.
 */
export function sweepBotErrorsOutboxTemps(options: { summaryInstance?: string } = {}): OutboxTempSweepResult {
  const result: OutboxTempSweepResult = {
    scanned: 0,
    promoted: 0,
    skipped: 0,
    errors: 0,
    retired: { 'torn': 0, 'schema-invalid': 0, 'unsafe-content': 0, 'stale-ttl': 0, 'already-published': 0 },
    retireDeferred: 0,
    retireDeferredNew: 0,
    scratchRetired: 0,
    lostAfterValidation: 0,
    lostEventIds: [],
    summaryEmitted: false,
  };
  if (outboxTempSweepInFlight) return result;
  outboxTempSweepInFlight = true;
  const deferredKeys: string[] = [];
  let scanCompleted = false;
  try {
    scanCompleted = sweepOutboxTempsInto(botErrorsOutboxDir(), result, deferredKeys);
  } catch {
    result.errors += 1;
  } finally {
    // Even if the scan aborts, temps it already retired (and unlinked) must
    // reach the summary. The in-flight flag stays set until the summary's own
    // write has returned, so that write cannot start a nested sweep.
    try {
      // A completed scan saw every temp still on disk, so a reported key it did
      // not defer again belongs to a temp that is gone or no longer deferred:
      // drop it. A still-deferred temp is re-seen every sweep, so this costs at
      // most one extra report (after a temp's processing throws once), never a
      // missed one. An incomplete scan proves nothing about absent keys.
      if (scanCompleted) {
        const seen = new Set(deferredKeys);
        for (const key of reportedDeferredOutboxTemps) {
          if (!seen.has(key)) reportedDeferredOutboxTemps.delete(key);
        }
      }
      // A deferred temp is reportable only while the capped set has room to
      // remember it, so each one can trigger at most one summary per process.
      const room = Math.max(0, deferredReportCap - reportedDeferredOutboxTemps.size);
      const reportable = [...new Set(deferredKeys)]
        .filter((key) => !reportedDeferredOutboxTemps.has(key))
        .slice(0, room);
      result.retireDeferredNew = reportable.length;
      emitOutboxTempSweepSummary(result, options.summaryInstance ?? 'unknown');
      // Remembered only once a summary carried them; a failed emit retries next sweep.
      if (result.summaryEmitted) for (const key of reportable) reportedDeferredOutboxTemps.add(key);
    } catch {
      result.errors += 1;
    }
    outboxTempSweepInFlight = false;
  }
  return result;
}

/** Identity of a deferred temp for once-per-process reporting: device, inode and name. */
function deferredOutboxTempKey(tempName: string, stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}:${tempName}`;
}

/** Returns true when the directory was read and every entry was visited. */
function sweepOutboxTempsInto(outbox: string, result: OutboxTempSweepResult, deferredKeys: string[]): boolean {
  let entries: string[];
  try {
    entries = readdirSync(outbox);
  } catch {
    result.errors += 1;
    return false;
  }
  const published: PublishedOutboxNames = { names: new Set(), ids: new Set() };
  for (const name of entries) {
    const final = OUTBOX_FINAL_NAME_RE.exec(name);
    if (final) {
      published.names.add(name);
      published.ids.add(final[1]!);
    }
  }
  const nowMs = systemClock.now();
  // One probe per distinct pid per sweep: on macOS each probe of a live pid
  // spawns `ps` synchronously on the alert path. Scoped to this sweep, so a
  // later sweep never reuses a stale liveness answer.
  const probed = new Map<number, OutboxTempProcessState>();
  // Names this sweep unlinked as hard-linked siblings of an event it
  // published. Such a name may still be ahead in `entries`; its ENOENT then
  // is this sweep's own cleanup, not an error.
  const cleaned = new Set<string>();
  const probeOnce = (pid: number): OutboxTempProcessState => {
    let state = probed.get(pid);
    if (state === undefined) {
      state = outboxTempProcessProbe(pid);
      probed.set(pid, state);
    }
    return state;
  };
  // Promotion intents first (resolvePromoteIntent). A final whose intent is
  // still on disk is held: none of its temps or scratch files is touched.
  const held = new Set<string>();
  let resolvedIntent = false;
  for (const name of entries) {
    const intent = OUTBOX_PROMOTE_INTENT_NAME_RE.exec(name);
    if (!intent) continue;
    try {
      if (resolvePromoteIntent(outbox, name, intent[1]!, Number(intent[2]), nowMs, probeOnce, cleaned) === 'resolved') {
        resolvedIntent = true;
        continue;
      }
    } catch {
      // Deliberately: counted, and the intent keeps holding its final's temps.
      result.errors += 1;
    }
    held.add(intent[1]!);
  }
  // Names the resolution removed must not reach the per-temp path as errors.
  if (resolvedIntent) entries = readdirSync(outbox);
  for (const name of entries) {
    const scratch = OUTBOX_PROMOTE_SCRATCH_NAME_RE.exec(name);
    const scratchFinal = scratch ? OUTBOX_FINAL_NAME_RE.exec(scratch[1]!) : null;
    if (scratch && scratchFinal) {
      if (held.has(scratch[1]!)) continue;
      try {
        if (retireStaleOutboxPromoteScratch(outbox, name, scratchFinal[1]!, Number(scratch[2]), nowMs)) {
          result.scratchRetired += 1;
        }
      } catch {
        result.errors += 1;
      }
      continue;
    }
    const temp = OUTBOX_TEMP_NAME_RE.exec(name);
    const final = temp ? OUTBOX_FINAL_NAME_RE.exec(temp[1]!) : null;
    if (!temp || !final) continue;
    result.scanned += 1;
    if (held.has(temp[1]!)) {
      result.skipped += 1;
      continue;
    }
    // Per temp: one temp that throws must not end the scan for the rest.
    try {
      const outcome = sweepOneOutboxTemp(
        outbox, name, temp[1]!, final[1]!, Number(temp[2]), nowMs, published, probeOnce, deferredKeys, cleaned,
      );
      if (outcome === 'skipped') result.skipped += 1;
      else if (outcome === 'promoted') result.promoted += 1;
      else if (outcome === 'retire-deferred') result.retireDeferred += 1;
      else result.retired[outcome] += 1;
    } catch (err) {
      // Only a name this sweep removed itself is exempt; any other ENOENT (a
      // concurrent sweep took the temp, say) is still a sweep error.
      if (cleaned.has(name) && (err as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      result.errors += 1;
      if (err instanceof OutboxTempLostAfterValidationError) {
        result.lostAfterValidation += 1;
        result.lostEventIds.push(err.eventId);
      }
    }
  }
  return true;
}

function sweepOneOutboxTemp(
  outbox: string,
  tempName: string,
  finalName: string,
  fileId: string,
  pid: number,
  nowMs: number,
  published: PublishedOutboxNames,
  probe: (pid: number) => OutboxTempProcessState,
  deferredKeys: string[],
  cleaned: Set<string>,
): OutboxTempRetireClass | 'promoted' | 'skipped' | 'retire-deferred' {
  const tempPath = join(outbox, tempName);
  const stat = lstatSync(tempPath);
  if (!stat.isFile() || nowMs - stat.mtimeMs < OUTBOX_TEMP_GRACE_MS) return 'skipped';
  const owner = probe(pid);
  const orphaned = !owner.alive || (owner.startedAtMs !== null && owner.startedAtMs > stat.mtimeMs);
  if (!orphaned) return 'skipped';

  const deferredKey = deferredOutboxTempKey(tempName, stat);
  // Events are a few KiB: an oversized temp is schema-invalid without being read.
  let retireClass: OutboxTempRetireClass = 'schema-invalid';
  if (stat.size <= OUTBOX_TEMP_MAX_BYTES) {
    const fd = openOutboxTempOrRecordLoss(outbox, tempPath, finalName, fileId, stat);
    try {
      const validatedBytes = readFileSync(fd);
      const classified = classifyOutboxTempBytes(validatedBytes, stat.mtimeMs, finalName, fileId, nowMs, published);
      if (classified === null) {
        const outcome = promoteValidatedOutboxTemp(
          outbox, tempPath, finalName, fileId, fd, stat, validatedBytes, cleaned,
        );
        if (outcome === 'promoted') {
          published.names.add(finalName);
          published.ids.add(fileId);
          reportedDeferredOutboxTemps.delete(deferredKey);
        }
        return outcome;
      }
      retireClass = classified;
    } finally {
      closeSync(fd);
    }
  }
  // Without a breadcrumb the temp is the only record of what was lost: keep it
  // and let a later sweep retry the retirement.
  if (!recordOutboxTempRetirement(tempName, fileId, retireClass, stat.size, stat.mtimeMs, pid)) {
    // Only a deferred LOSS is reportable: an already-published temp lost
    // nothing, and the summary asserts an unrecoverable, confirmed loss.
    if (retireClass !== 'already-published') deferredKeys.push(deferredKey);
    return 'retire-deferred';
  }
  // Unlink only the object that was classified. A temp a concurrent sweep
  // already took counts as a sweep error, as before; anything swapped in at
  // the path is left for a later sweep to classify on its own.
  const current = lstatSync(tempPath, { throwIfNoEntry: false });
  if (!current) throw new Error('outbox temp vanished before its retirement unlink');
  if (current.dev === stat.dev && current.ino === stat.ino) unlinkSync(tempPath);
  reportedDeferredOutboxTemps.delete(deferredKey);
  return retireClass;
}

/**
 * Open the temp and prove the descriptor names the very object the lstat
 * checked. The path can be swapped between the lstat and this open:
 * O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a FIFO (or device) from
 * blocking the alert path in open; the fstat then refuses anything that is
 * not a regular file, or is not the same device and inode. O_NONBLOCK has no
 * effect on regular files. Throws (a sweep error) on any refusal.
 */
function openCheckedOutboxTemp(tempPath: string, checked: { dev: number; ino: number }): number {
  const fd = openSync(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new OutboxTempSwappedAtOpenError('outbox temp is not a regular file at open');
    }
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
      throw new OutboxTempSwappedAtOpenError('outbox temp is not the object lstat checked');
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * openCheckedOutboxTemp, plus loss reporting for a swap between the lstat and
 * the open. When the path now names a different object (another regular
 * file, a non-regular file, or a symlink that O_NOFOLLOW refuses with ELOOP)
 * and the original is no longer anywhere in the outbox, the event is lost: a
 * `.templost` breadcrumb records the id from the temp's file NAME (the
 * descriptor, if any, holds the swapped-in file, so no content is trusted)
 * and the loss is counted like a loss after validation. A peer sweep's claim
 * keeps the original in the outbox under its claim name, and a plain ENOENT
 * (the path emptied, the normal single-winner race) is not a swap: both stay
 * plain sweep errors with no breadcrumb.
 */
function openOutboxTempOrRecordLoss(
  outbox: string,
  tempPath: string,
  finalName: string,
  fileId: string,
  checked: { dev: number; ino: number },
): number {
  try {
    return openCheckedOutboxTemp(tempPath, checked);
  } catch (err) {
    const swapped = err instanceof OutboxTempSwappedAtOpenError
      || (err as NodeJS.ErrnoException | null)?.code === 'ELOOP';
    if (swapped && !outboxStillHoldsEvent(outbox, finalName, fileId, checked)) {
      recordOutboxTempLoss(fileId, tempPath, 'swapped-before-open');
      throw new OutboxTempLostAfterValidationError(fileId);
    }
    throw err;
  }
}

/**
 * True when the outbox still holds the original object under any name (a
 * peer's claim, a hard link), or the event is already published under its
 * final name or id. Throws if the outbox cannot be listed, so an unknown
 * outcome stays a plain sweep error rather than a claimed loss.
 */
function outboxStillHoldsEvent(
  outbox: string,
  finalName: string,
  fileId: string,
  original: { dev: number; ino: number },
): boolean {
  for (const name of readdirSync(outbox)) {
    if (name === finalName || OUTBOX_FINAL_NAME_RE.exec(name)?.[1] === fileId) return true;
    const current = lstatSync(join(outbox, name), { throwIfNoEntry: false });
    if (current && current.dev === original.dev && current.ino === original.ino) return true;
  }
  return false;
}

// An orphaned temp did not necessarily come from the production builder. A
// capability can ride in a URL fragment or in a protected-delivery fragment
// (#v3 managed delivery, #i1 intake), so recovery refuses any string, at any
// depth, that carries one; publishing it would hand the capability to a chat.
// A URL is any RFC 3986 scheme followed by `//` (https, ftp, wss, ...), a
// scheme-relative `//host`, or a bare `www.` host. A `//` with nothing
// attached ("a // comment #7") and a bare "#42" are not URLs.
//
// The check is linear in the string. A URL and its fragment lie in one token,
// a run of characters up to whitespace, a quote or an angle bracket, and a
// capability needs a `#` after the URL start, so each token that holds a `#`
// is tested once, on the part before its last `#`. There each alternative
// starts at a fixed marker or at the start of a run of scheme characters (a
// scheme begins at the run's first letter), so no start rescans the run.
const URL_TOKEN_DELIMITER = /[\s"'<>]/u;
const URL_BEFORE_FRAGMENT = new RegExp(
  [
    String.raw`(?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/`,
    String.raw`(?<![A-Za-z0-9:/])\/\/[^/]`,
    String.raw`www\.`,
  ].join('|'),
  'iu',
);
const PROTECTED_FRAGMENT_CAPABILITY = /#(?:v3|i1)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?=$|[^A-Za-z0-9_-])/iu;

function containsUrlFragmentCapability(text: string): boolean {
  if (!text.includes('#')) return false;
  for (const token of text.split(URL_TOKEN_DELIMITER)) {
    const lastHash = token.lastIndexOf('#');
    if (lastHash > 0 && URL_BEFORE_FRAGMENT.test(token.slice(0, lastHash))) return true;
  }
  return false;
}

function containsFragmentCapability(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (containsUrlFragmentCapability(current) || PROTECTED_FRAGMENT_CAPABILITY.test(current)) return true;
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) pending.push(key, item);
  }
  return false;
}

/** A retire class, or null when these bytes are a complete, publishable event. */
function classifyOutboxTempBytes(
  raw: Buffer,
  mtimeMs: number,
  finalName: string,
  fileId: string,
  nowMs: number,
  published: PublishedOutboxNames,
): OutboxTempRetireClass | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return 'torn';
  }
  if (!isPublishableOutboxEvent(parsed, finalName)) return 'schema-invalid';
  if (published.names.has(finalName) || published.ids.has(fileId)) return 'already-published';
  if (containsFragmentCapability(parsed)) return 'unsafe-content';
  const ageMs = nowMs - Math.min(mtimeMs, Date.parse(parsed.createdAt));
  return ageMs > OUTBOX_TEMP_TTL_MS ? 'stale-ttl' : null;
}

/**
 * Promote a validated temp, bound to what was validated.
 *
 * 1. Refresh the validated inode's mtime through the open descriptor, so a
 *    concurrent sweep sees it inside the grace period, and as belonging to a
 *    live pid that started before it, and leaves it alone.
 *    (The mtime is set explicitly, which needs the sweeping uid to own the
 *    file: the outbox is a single-uid 0700 directory.)
 * 2. Claim it: rename the temp to a fresh `.<finalName>.<our pid>.c<N>.tmp`
 *    (claimOutboxTempName: unique per claim, never an existing name). The
 *    rename is the single-winner step: a sweep in another process that
 *    validated the same temp gets ENOENT (a sweep error) and publishes nothing.
 *    A crash after the claim leaves an orphan in a shape sweeps recover.
 * 3. Prove the claim is the validated object: lstat(claim) must have the
 *    fd's device and inode. Otherwise something else was swapped in at the
 *    temp path (for example after a peer claimed the validated file, which
 *    that peer will publish): refuse to publish (a sweep error) and leave the
 *    claim for a later sweep to classify on its own. When no name holds the
 *    validated file any more (fstat link count 0: the swap destroyed it),
 *    the event is lost: a `.templost` breadcrumb names its event id and the
 *    sweep's summary counts and names it. It is still not published. If the
 *    claimed file has other names (link count above 1), unlink every other
 *    temp-shaped name for the same final name that is that file, before
 *    publishing, so a second sweep cannot claim one of them and publish too.
 * 4. Publish the validated BYTES, never the file at a path, through the
 *    writer's durable path: an exclusive-create `.<finalName>.<our pid>.promote.tmp`
 *    scratch file, fsync, rename to the final name, chmod 0600, directory fsync.
 * 5. Unlink the claim, only if it is still the validated object, and any
 *    other temp-shaped name for the same final name that is a hard link to
 *    the validated file (what a restore whose claim unlink failed leaves, if
 *    the cleanup in step 3 missed it), so no later sweep can publish it again.
 *
 * On a throw BEFORE the final rename, nothing was published: the claim is put
 * back at the temp path (see restoreOutboxTempClaim), so the next sweep
 * retries it exactly as before the claim. On a throw AFTER the final rename,
 * the event is published: the claim and its hard-linked siblings are still
 * unlinked (identity checked). Either way the error is rethrown and counted as
 * a sweep error.
 */
function promoteValidatedOutboxTemp(
  outbox: string,
  tempPath: string,
  finalName: string,
  fileId: string,
  fd: number,
  validated: { dev: number; ino: number; atime: Date; mtime: Date },
  validatedBytes: Buffer,
  cleaned: Set<string>,
): 'promoted' {
  outboxTempBeforePromoteHook?.(tempPath);
  const now = new Date(systemClock.now());
  futimesSync(fd, now, now);
  const claimPath = claimOutboxTempName(outbox, finalName);
  renameSync(tempPath, claimPath);
  const finalPath = join(outbox, finalName);
  const intentPath = join(outbox, `.${finalName}.${process.pid}.promote.intent`);
  let finalRenamed = false;
  try {
    const claimed = lstatSync(claimPath);
    const held = fstatSync(fd);
    if (claimed.dev !== held.dev || claimed.ino !== held.ino) {
      if (held.nlink === 0) {
        recordOutboxTempLoss(fileId, tempPath, 'swapped-after-validation');
        throw new OutboxTempLostAfterValidationError(fileId);
      }
      throw new Error('claimed outbox temp is not the validated object');
    }
    if (held.nlink > 1) {
      // Other names hold the file this sweep now owns (a restore whose claim
      // unlink failed). Remove them before publishing, so that another sweep
      // cannot claim one of them and publish the event as well. Best effort:
      // the cleanup after the publish tries again.
      try {
        unlinkHardLinkedSiblings(outbox, finalName, fd, validated, cleaned, basename(claimPath));
      } catch {
        // Deliberately: the sibling cleanup is retried after the publish.
      }
    }
    const scratchPath = join(outbox, `.${finalName}.${process.pid}.promote.tmp`);
    let scratchCreated = false;
    let intentCreated = false;
    try {
      // Opened here, not through writeFileDurable, so the created flag is set
      // the moment the file exists: a write or fsync failure after the open
      // must remove it, or its name would block every later promotion of this
      // final name by this pid (EEXIST) until the scratch TTL.
      const scratchFd = openSync(
        scratchPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      scratchCreated = true;
      try {
        outboxTempScratchWriteHook?.(scratchPath);
        writeFileSync(scratchFd, validatedBytes);
        fsyncSync(scratchFd);
      } finally {
        closeSync(scratchFd);
      }
      // The intent, durable once the scratch is complete and before the final
      // rename; removed only after the claim unlink (resolvePromoteIntent).
      const intentFd = openSync(
        intentPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      intentCreated = true;
      try {
        outboxTempIntentWriteHook?.(intentPath);
        writeFileSync(intentFd, promoteIntentBytes(finalName, claimPath, validated));
        fsyncSync(intentFd);
      } finally {
        closeSync(intentFd);
      }
      fsyncDirectory(outbox);
      outboxTempBeforeFinalRenameHook?.(finalPath);
      renameSync(scratchPath, finalPath);
      finalRenamed = true;
    } catch (err) {
      // Only a scratch this call created: a pre-existing one (EEXIST) holds a
      // payload and is retired by its own rule, with a breadcrumb. While an
      // intent names the scratch, the scratch may disappear only through the
      // final rename (a sweep that finds the intent without it takes the event
      // as published), so the intent goes first, and if it cannot, the
      // scratch stays.
      if (scratchCreated && !finalRenamed && (!intentCreated || unlinkPromoteIntent(intentPath))) {
        unlinkQuietly(scratchPath);
      }
      throw err;
    }
    outboxTempAfterPublishHook?.(finalPath);
    chmodSync(finalPath, 0o600);
    fsyncDirectory(outbox);
    unlinkIfSameObject(claimPath, validated);
    unlinkHardLinkedSiblings(outbox, finalName, fd, validated, cleaned, null);
    // Only now that no name for the published file is left to publish again.
    unlinkSync(intentPath);
  } catch (err) {
    if (finalRenamed) {
      // Published: neither the claim nor a hard-linked sibling may survive to
      // be published again. Until both are gone the intent stays, so a later
      // sweep removes them and never publishes them (resolvePromoteIntent).
      let claimCleared = true;
      try {
        unlinkIfSameObject(claimPath, validated);
      } catch {
        // Deliberately: the intent stays and holds the claim; a later sweep unlinks it.
        claimCleared = false;
      }
      try {
        unlinkHardLinkedSiblings(outbox, finalName, fd, validated, cleaned, null);
      } catch {
        // Deliberately: the intent stays and holds the sibling; a later sweep unlinks it.
        claimCleared = false;
      }
      if (claimCleared) unlinkPromoteIntent(intentPath);
    } else if (
      // A loss already recorded before the claim check needs no restore.
      !(err instanceof OutboxTempLostAfterValidationError)
      && restoreOutboxTempClaim(outbox, claimPath, tempPath, finalName, fileId, fd, validated)
    ) {
      throw new OutboxTempLostAfterValidationError(fileId);
    }
    throw err;
  }
  return 'promoted';
}

/**
 * A claim name no file has: `.<finalName>.<our pid>.c<N>.tmp` with a
 * per-process counter, skipping any name that exists, so a claim can never
 * overwrite a file retained under an earlier claim name. The name keeps the
 * writer temp shape with this process's pid, so a crash leaves an orphan a
 * later sweep recovers.
 */
function claimOutboxTempName(outbox: string, finalName: string): string {
  for (let attempt = 0; attempt < OUTBOX_TEMP_CLAIM_NAME_ATTEMPTS; attempt += 1) {
    outboxTempClaimCounter += 1;
    const candidate = join(outbox, `.${finalName}.${process.pid}.c${outboxTempClaimCounter}.tmp`);
    if (!lstatSync(candidate, { throwIfNoEntry: false })) return candidate;
  }
  throw new Error('no free outbox temp claim name');
}

/**
 * Nothing was published: put the validated file back at the temp path with
 * its original mtime, so the next sweep retries it as the orphan it was.
 *
 * Order matters. link(2) first, while the file still carries the fresh mtime
 * the claim gave it: it refuses (EEXIST) rather than clobber anything now at
 * the temp path. Then the identity-checked unlink of the claim. Only once the
 * claim name is gone is the original mtime put back. So while two names hold
 * the file, both look fresh (inside grace) and no sweep takes either; they
 * never both look like old orphans.
 *
 * A claim that is not the validated object (a swap) is left for a later sweep.
 * If the claim is gone or is another object AND no name holds the validated
 * file any more (link count 0) AND the event is not published under its final
 * name or id (a peer's successful publish), the event is lost: for example two sweeps
 * each claimed one of two hard-linked names and each one's early sibling
 * cleanup removed the other's claim. That loss is recorded (a `.templost`
 * breadcrumb of class restore-unheld, with the id from the temp's name) and
 * reported by returning true, so the caller counts it. The validated bytes
 * are deliberately not rewritten to a fresh temp: both sweeps would do it,
 * and the event would then be delivered twice.
 *
 * Never throws. If the link fails (it needs a directory entry, so ENOSPC can
 * refuse it too), the claim stays. It carries this process's pid, which is
 * alive and started before the claim's mtime, so it is NOT an orphan
 * candidate while this process lives: it is recovered only after the process
 * exits. If the link succeeded but the claim unlink then failed, both names
 * keep the fresh mtime: the temp (a dead writer's pid) is recovered after the
 * grace period, and when it is published the hard-linked claim is unlinked
 * with it (unlinkHardLinkedSiblings).
 */
function restoreOutboxTempClaim(
  outbox: string,
  claimPath: string,
  tempPath: string,
  finalName: string,
  fileId: string,
  fd: number,
  validated: { dev: number; ino: number; atime: Date; mtime: Date },
): boolean {
  try {
    const claimed = lstatSync(claimPath, { throwIfNoEntry: false });
    if (!claimed || claimed.dev !== validated.dev || claimed.ino !== validated.ino) {
      if (fstatSync(fd).nlink !== 0) return false;
      // The peer that removed this claim may have published the event: not a
      // loss. An outbox that cannot be listed throws into the catch below, so
      // an unknown outcome stays a plain sweep error, as for a swap at open.
      if (outboxStillHoldsEvent(outbox, finalName, fileId, validated)) return false;
      recordOutboxTempLoss(fileId, tempPath, 'restore-unheld');
      return true;
    }
    linkSync(claimPath, tempPath);
    outboxTempRestoreLinkedHook?.(tempPath, claimPath);
    unlinkIfSameObject(claimPath, validated);
    futimesSync(fd, validated.atime, validated.mtime);
  } catch {
    // Deliberately: the claim stays where it is, and the false result reports that no restore happened.
  }
  return false;
}

/**
 * Right after the claim (sparing the claim name `keep`) and again after the
 * publish (keep null): if other names still hold the validated file, unlink
 * every temp-shaped name for the same final name that is that file (same
 * device and inode). Such a name exists only when a restore's claim unlink
 * failed; left alone, another or a later sweep could publish it again. Each
 * name unlinked is added to `cleaned`, so this sweep does not count its own
 * cleanup as an error when it reaches that name in its listing.
 */
function unlinkHardLinkedSiblings(
  outbox: string,
  finalName: string,
  fd: number,
  validated: { dev: number; ino: number },
  cleaned: Set<string>,
  keep: string | null,
): void {
  if (fstatSync(fd).nlink === 0) return;
  for (const name of readdirSync(outbox)) {
    if (name === keep) continue;
    const temp = OUTBOX_TEMP_NAME_RE.exec(name);
    if (!temp || temp[1] !== finalName) continue;
    if (unlinkIfSameObject(join(outbox, name), validated)) cleaned.add(name);
  }
}

/**
 * An orphaned event whose file no name holds any more, so it is not
 * published: a content-free `.templost` breadcrumb that names the event id,
 * so the loss is traceable. `swapped-after-validation`: destroyed by a swap
 * between validation and the claim. `swapped-before-open`: destroyed by a
 * swap between the lstat and the open, so its content was never read and the
 * id is the one its file name carries. `restore-unheld`: a failed publish
 * found its own claim removed (by another sweep's sibling cleanup) and no
 * other name left, so there was nothing to restore. Best effort: the sweep's
 * summary counts and names the loss either way.
 */
function recordOutboxTempLoss(
  fileId: string,
  tempPath: string,
  lossClass: 'swapped-after-validation' | 'swapped-before-open' | 'restore-unheld',
): void {
  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_temp_lost',
    recordedAt: nowIso(),
    class: lossClass,
    eventId: fileId,
    tempName: basename(tempPath),
    emitPid: process.pid,
  };
  publishWritefailRecord(
    `${writefailStamp()}.${safeSegment(fileId)}.${process.pid}.${lossClass}.templost`,
    `${JSON.stringify(breadcrumb, null, 2)}\n`,
  );
}

/**
 * Unlink `path` only if it still names the object with this device and inode.
 * Returns whether it unlinked.
 */
function unlinkIfSameObject(path: string, object: { dev: number; ino: number }): boolean {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current || current.dev !== object.dev || current.ino !== object.ino) return false;
  unlinkSync(path);
  return true;
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Deliberately: cleanup of a scratch this call created is best effort; its own TTL rule retires a leftover.
  }
}

/** What a promotion intent records: the claim and the identity of the validated file. */
function promoteIntentBytes(finalName: string, claimPath: string, claimed: { dev: number; ino: number }): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: 'outbox_promote_intent',
    finalName,
    claimName: basename(claimPath),
    dev: claimed.dev,
    ino: claimed.ino,
    pid: process.pid,
  })}\n`;
}

/** Remove a promotion intent. True when no intent is left at the path. */
function unlinkPromoteIntent(intentPath: string): boolean {
  try {
    unlinkSync(intentPath);
  } catch (err) {
    // Deliberately: the caller keeps what the intent guards when it cannot go.
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
  }
  return true;
}

/**
 * A promotion intent left by a process that is gone (the same orphan rule as a
 * temp: past the grace period, and its pid dead or started after the intent).
 * While an intent exists its scratch disappears only through the final
 * rename, so the scratch decides:
 * - scratch present: the final rename never happened. The intent and then the
 *   scratch go; the claim is still the only copy, and the per-temp path
 *   publishes it exactly once.
 * - scratch gone: the event was published, and the dispatcher may already
 *   have consumed the final. Every temp-shaped name for that final that is
 *   still the claimed file (dev and inode from the intent) goes, then the
 *   intent. Nothing is published.
 * 'held' when its process may still be promoting. An intent that cannot be
 * read with its scratch gone throws (a sweep error) and stays, holding the
 * final's temps: they are never published again.
 */
function resolvePromoteIntent(
  outbox: string,
  intentName: string,
  finalName: string,
  pid: number,
  nowMs: number,
  probe: (pid: number) => OutboxTempProcessState,
  cleaned: Set<string>,
): 'held' | 'resolved' {
  const intentPath = join(outbox, intentName);
  const stat = lstatSync(intentPath);
  if (!stat.isFile() || nowMs - stat.mtimeMs < OUTBOX_TEMP_GRACE_MS) return 'held';
  const owner = probe(pid);
  const orphaned = !owner.alive || (owner.startedAtMs !== null && owner.startedAtMs > stat.mtimeMs);
  if (!orphaned) return 'held';
  const scratchName = `.${finalName}.${pid}.promote.tmp`;
  if (lstatSync(join(outbox, scratchName), { throwIfNoEntry: false })) {
    unlinkSync(intentPath);
    unlinkQuietly(join(outbox, scratchName));
    cleaned.add(scratchName);
    return 'resolved';
  }
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as { dev?: unknown; ino?: unknown };
  if (typeof intent.dev !== 'number' || typeof intent.ino !== 'number') {
    throw new Error('promotion intent does not name the claimed file');
  }
  const claimed = { dev: intent.dev, ino: intent.ino };
  for (const name of readdirSync(outbox)) {
    const temp = OUTBOX_TEMP_NAME_RE.exec(name);
    if (temp?.[1] === finalName && unlinkIfSameObject(join(outbox, name), claimed)) cleaned.add(name);
  }
  unlinkSync(intentPath);
  return 'resolved';
}

/**
 * Retire a `.promote.tmp` scratch file (left by a crash mid-publish) once it
 * is older than the TTL: a content-free breadcrumb first, then an
 * identity-checked unlink. Without a breadcrumb it is kept. Returns true when
 * it was retired. A scratch file is litter, not a lost alert: the claim it
 * was published from survives the crash and is recovered on its own.
 */
function retireStaleOutboxPromoteScratch(
  outbox: string,
  scratchName: string,
  fileId: string,
  pid: number,
  nowMs: number,
): boolean {
  const scratchPath = join(outbox, scratchName);
  const stat = lstatSync(scratchPath);
  if (!stat.isFile() || nowMs - stat.mtimeMs <= OUTBOX_TEMP_TTL_MS) return false;
  if (!recordOutboxTempRetirement(scratchName, fileId, 'stale-promote-scratch', stat.size, stat.mtimeMs, pid)) {
    return false;
  }
  unlinkIfSameObject(scratchPath, stat);
  return true;
}

/**
 * The shape buildBotErrorsEvent produces: a v2 envelope it can emit, and
 * identity fields that re-derive exactly this file name (so the id in the
 * name is the event's id).
 */
function isPublishableOutboxEvent(
  value: unknown,
  finalName: string,
): value is { createdAt: string; instance: string; source: string; id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.schemaVersion !== 2) return false;
  // Strings only, as the dispatcher requires (bot_errors_envelope.py,
  // _required_string): String() would read ["critical"] as "critical".
  const { eventKind, eventType, severity } = event;
  if (typeof eventKind !== 'string' || typeof eventType !== 'string' || typeof severity !== 'string'
      || !KNOWN_ENVELOPES.has(`${eventKind}|${eventType}|${severity}`)) {
    return false;
  }
  const { createdAt, instance, source, id } = event;
  if (typeof createdAt !== 'string' || typeof instance !== 'string'
      || typeof source !== 'string' || typeof id !== 'string') {
    return false;
  }
  if (!Number.isFinite(Date.parse(createdAt))) return false;
  return outboxEventFileName({ createdAt, instance, source, id }) === finalName;
}

/**
 * Content-free by design: never the payload, only where and what it was.
 * Returns false when no writefail directory accepted the breadcrumb.
 */
function recordOutboxTempRetirement(
  tempName: string,
  fileId: string,
  retireClass: OutboxTempRetireClass | 'stale-promote-scratch',
  size: number,
  mtimeMs: number,
  pid: number,
): boolean {
  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_temp_retired',
    recordedAt: nowIso(),
    class: retireClass,
    tempName,
    size,
    mtime: new Date(mtimeMs).toISOString(),
    pid,
    emitPid: process.pid,
  };
  return publishWritefailRecord(
    `${writefailStamp()}.${safeSegment(fileId)}.${pid}.${retireClass}.tempretire`,
    `${JSON.stringify(breadcrumb, null, 2)}\n`,
  ) !== null;
}

function emitOutboxTempSweepSummary(result: OutboxTempSweepResult, instance: string): void {
  const torn = result.retired['torn'];
  const schemaInvalid = result.retired['schema-invalid'];
  const unsafeContent = result.retired['unsafe-content'];
  const staleTtl = result.retired['stale-ttl'];
  // A completed loss triggers the summary, and so does a deferred temp this
  // process has not reported yet (a kept torn/invalid/stale temp is a loss
  // whose breadcrumb could not be written). Already-reported deferred temps
  // and sweep errors do not: they would page once a minute per process. A
  // deferred already-published temp never does: it lost nothing. Their counts
  // ride along whenever a summary is sent. A validated event lost to a swap
  // before its claim always triggers it, and is named by event id.
  if (torn + schemaInvalid + unsafeContent + staleTtl + result.retireDeferredNew + result.lostAfterValidation === 0) return;
  // Counts ride criticalAsset: summary and evidence are confined to digests.
  // Event ids are identifiers, not content; at most a bounded few are named.
  const counts = [
    `torn=${torn}`,
    `schema-invalid=${schemaInvalid}`,
    `unsafe-content=${unsafeContent}`,
    `stale-ttl=${staleTtl}`,
    `retire-deferred=${result.retireDeferred}`,
    `retire-deferred-new=${result.retireDeferredNew}`,
    `lost-after-validation=${result.lostAfterValidation}`,
    `sweep-error=${result.errors}`,
    ...result.lostEventIds.slice(0, OUTBOX_TEMP_SUMMARY_LOST_IDS_MAX).map((id) => `lost-event=${id}`),
  ];
  try {
    writeBotErrorsEvent({
      eventType: 'observation',
      instance,
      source: OUTBOX_TEMP_SWEEP_SOURCE,
      summary: `bot-errors outbox temp sweep: orphaned temps lost or awaiting retirement: ${counts.join(' ')}`,
      criticalAsset: {
        asset: { kind: 'bot_errors_delivery', instance },
        failure: {
          code: 'OUTBOX_TEMP_RETIRED',
          domain: 'bot_errors_delivery',
          recoverability: 'unrecoverable',
          confidence: 'confirmed',
          operatorAction: `Orphaned outbox temps were retired undelivered or await retirement (${counts.join(', ')}); `
            + 'each retired temp has a .tempretire breadcrumb in the writefail directory; '
            + 'retire-deferred temps are kept in the outbox because no breadcrumb could be written, '
            + 'and are retried every sweep; a deferred lost alert (not an already-published one) '
            + 'is reported once per process; '
            + 'lost-after-validation events were destroyed by a swap before their claim and are not delivered '
            + '(each has a .templost breadcrumb naming its event id); '
            + 'sweep-error temps are normally left in place and retried, '
            + 'except a temp a concurrent sweep already took.',
          clearRequirement: 'none; one-shot observation',
        },
        evidenceRefs: counts,
      },
    });
    result.summaryEmitted = true;
  } catch (err) {
    const breadcrumb = {
      schemaVersion: 1,
      kind: 'outbox_temp_sweep_summary_failed',
      recordedAt: nowIso(),
      counts,
      reason: redactText(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      emitPid: process.pid,
    };
    publishWritefailRecord(
      `${writefailStamp()}.${process.pid}.temp-sweep-summary.tempsweepfail`,
      `${JSON.stringify(breadcrumb, null, 2)}\n`,
    );
  }
}
