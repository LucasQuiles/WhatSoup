import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { forceEnsurePrivateDirectorySync, fsyncDirectory } from './private-fs.ts';
import { confineAlertContent, confineConversationScope } from './alert-evidence.ts';
import { redactText } from './redaction-text.ts';
import { asNonEmptyString } from './type-guards.ts';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

function writeFileDurable(path: string, payload: string): void {
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
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = `${stamp}.${safeSegment(instance)}.${safeSegment(eventId)}.writefail`;
  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: nowIso(),
    failedTarget: redactText(target),
    reason,
    emitPid: process.pid,
    event: redactOutboxValue(event),
  };
  const payload = `${JSON.stringify(breadcrumb, null, 2)}\n`;

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
  // Preserve milliseconds while sorting *after* old same-second names, which
  // ended at `...SSZ.<instance>`. `_` sorts after that separator and keeps
  // new fractional timestamps lexical within their second.
  const fractionalTimestamp = event.createdAt.match(/^(.*)\.(\d{3})Z$/);
  const created = fractionalTimestamp
    ? `${fractionalTimestamp[1]!.replace(/[-:]/g, '')}Z_${fractionalTimestamp[2]}`
    : event.createdAt.replace(/[-:]/g, '');
  const fileName = `${created}.${safeSegment(event.instance)}.${safeSegment(event.source)}.${event.id}.json`;
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

  return { eventId: event.id, path: finalPath };
}
