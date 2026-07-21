import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createChildLogger } from '../logger.ts';
import {
  buildBotErrorsEvent,
  writeBotErrorsEvent,
  type BotErrorsCriticalAssetDiagnostic,
  type BotErrorsLegacyOutboxInput,
  type BotErrorsOutboxInput,
  type BotErrorsOutboxWrite,
  type BotErrorsProtocolInput,
  type BotErrorsSeverity,
} from './bot-errors-outbox.ts';

const log = createChildLogger('emit-alert');
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from './error-message.ts';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
let missingScriptWarned = false;
let missingTargetWarned = false;
let invalidTargetWarned = false;
let missingExpectedTargetWarned = false;
let driftedTargetWarned = false;

const GROUP_JID_RE = /^\d+@g\.us$/;

// ---------------------------------------------------------------------------
// In-process alert throttle
// ---------------------------------------------------------------------------

/**
 * Window (ms) within which duplicate (instance, source, summary) triples are
 * suppressed at the legacy-spawn layer.  Only the legacy path is throttled;
 * the durable outbox path is unthrottled (the dispatcher handles dedup).
 *
 * Set EMIT_ALERT_THROTTLE_MS=0 to disable.  Values < 0 are treated as 0.
 * Default: 300_000 ms (5 min).
 */
const EMIT_ALERT_THROTTLE_MS = (() => {
  const raw = Number(process.env['EMIT_ALERT_THROTTLE_MS']);
  if (Number.isFinite(raw)) return Math.max(0, raw);
  return 300_000;
})();

/** Maps `${instance}|${source}|${summary}` → epoch ms of first legacy spawn. */
const alertThrottleMap = new Map<string, number>();

/** Reset the in-process throttle map (for tests). */
export function resetEmitAlertThrottle(): void {
  alertThrottleMap.clear();
}

/** Returns true when the legacy spawn should be suppressed. */
function isThrottled(instance: string, source: string, summary: string): boolean {
  const throttleMs = Number(process.env['EMIT_ALERT_THROTTLE_MS'] ?? EMIT_ALERT_THROTTLE_MS);
  const effectiveWindow = Number.isFinite(throttleMs) ? Math.max(0, throttleMs) : EMIT_ALERT_THROTTLE_MS;
  if (effectiveWindow === 0) return false;

  const now = Date.now();
  // Prune expired entries on insert.
  for (const [key, recordedAt] of alertThrottleMap) {
    if (now - recordedAt > effectiveWindow) alertThrottleMap.delete(key);
  }

  const key = `${instance}|${source}|${summary}`;
  if (alertThrottleMap.has(key)) return true;
  alertThrottleMap.set(key, now);
  return false;
}

// ---------------------------------------------------------------------------

interface LegacyAlertResult {
  attempted: boolean;
  accepted: boolean;
  reason?: string;
  error?: string;
}

export type AlertEmissionStatus = 'durably_queued' | 'legacy_accepted_unconfirmed' | 'failed';

export interface AlertEmissionResult {
  ok: boolean;
  channel: 'outbox' | 'legacy' | 'none' | 'sink';
  status: AlertEmissionStatus;
  outbox?: BotErrorsOutboxWrite;
  legacy?: LegacyAlertResult;
  outboxError?: string;
}

export interface AlertEmissionContext {
  instance: string;
  source: string;
  operation?: 'alert' | 'clear';
}

function protocolValidationFailure(
  err: unknown,
  instance: string,
  source: string,
  operation: 'alert' | 'clear',
): AlertEmissionResult | null {
  if (!(err instanceof Error) || err.name !== 'BotErrorsProtocolValidationError') return null;
  const reason = errorMessage(err);
  log.warn({ instance, source, err: reason }, `bot-errors ${operation} protocol validation failed`);
  return { ok: false, channel: 'none', status: 'failed', outboxError: reason };
}

function requireExpectedJid(): boolean {
  const raw = process.env['BOT_ERRORS_REQUIRE_EXPECTED']?.trim().toLowerCase();
  return raw ? !['0', 'false', 'no', 'off'].includes(raw) : true;
}

function botErrorsJid(): string | null {
  const jid = process.env['BOT_ERRORS_JID']?.trim();
  const expected = process.env['BOT_ERRORS_EXPECTED_JID']?.trim();
  if (!jid) {
    if (!missingTargetWarned) {
      missingTargetWarned = true;
      log.warn({}, 'BOT_ERRORS_JID not configured; legacy alert helper disabled');
    }
    return null;
  }
  if (!GROUP_JID_RE.test(jid)) {
    if (!invalidTargetWarned) {
      invalidTargetWarned = true;
      log.warn({ targetSuffix: jid.split('@').at(-1) ?? 'missing' }, 'BOT_ERRORS_JID is not a WhatsApp group JID; legacy alert helper disabled');
    }
    return null;
  }
  if (!expected && requireExpectedJid()) {
    if (!missingExpectedTargetWarned) {
      missingExpectedTargetWarned = true;
      log.warn({}, 'BOT_ERRORS_EXPECTED_JID not configured; legacy alert helper disabled');
    }
    return null;
  }
  if (expected && jid !== expected) {
    if (!driftedTargetWarned) {
      driftedTargetWarned = true;
      log.warn({}, 'BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID; legacy alert helper disabled');
    }
    return null;
  }
  return jid;
}

function alertScriptAvailable(): boolean {
  if (existsSync(ALERT_SCRIPT)) return true;
  if (!missingScriptWarned) {
    missingScriptWarned = true;
    log.warn({ script: ALERT_SCRIPT }, 'alert helper script not present; alerts will be silent');
  }
  return false;
}

function spawnLegacyAlert(args: string[], logContext: Record<string, unknown>, message: string): LegacyAlertResult {
  const target = botErrorsJid();
  if (!target) {
    log.warn(logContext, `${message}; legacy alert target not configured`);
    return { attempted: false, accepted: false, reason: 'target_not_configured' };
  }

  if (!alertScriptAvailable()) {
    log.warn(logContext, `${message}; legacy helper script not present`);
    return { attempted: false, accepted: false, reason: 'helper_unavailable' };
  }

  try {
    const child = spawn(
      ALERT_SCRIPT,
      ['--alert-target', target, ...args],
      { stdio: 'ignore', timeout: 5_000, detached: false, killSignal: 'SIGKILL' },
    );
    child.unref();
    child.on('error', (err) => {
      log.warn({ ...logContext, err: err.message }, `${message}; legacy helper failed`);
    });
    child.on('exit', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode !== 0 || signal !== null) {
        log.warn({ ...logContext, exitCode, signal }, `${message}; legacy helper exited non-zero or via signal`);
      }
    });
    return { attempted: true, accepted: true };
  } catch (err) {
    const reason = errorMessage(err);
    log.warn({ ...logContext, err: reason }, `${message}; legacy helper failed`);
    return { attempted: true, accepted: false, reason: 'spawn_failed', error: reason };
  }
}

/**
 * WHATSOUP_ALERT_SINK — dry-run capture surface. When set to a writable path,
 * alert/clear emissions are appended to that file (one JSON object per line,
 * redacted via {@link buildBotErrorsEvent} for parity with the durable outbox)
 * and NOTHING is paged: no durable outbox event, no legacy WhatsApp helper
 * spawn. This lets an alert verifier observe operator-facing alerts (e.g.
 * `provider_fallback_activated`, `fallback_no_independent_provider`) at runtime
 * without paging a live operator. Opt-in only; unset in production.
 */
function alertSinkPath(): string | null {
  const raw = process.env['WHATSOUP_ALERT_SINK']?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function withProtocol(
  input: BotErrorsLegacyOutboxInput,
  protocol: BotErrorsProtocolInput | undefined,
): BotErrorsOutboxInput {
  if (protocol === undefined) return input;
  return {
    ...input,
    observation: protocol.observation,
    clearPolicy: protocol.clearPolicy,
    remediation: protocol.remediation,
  } as BotErrorsOutboxInput;
}

function captureToAlertSink(
  sink: string,
  input: {
    eventType: 'alert' | 'clear';
    instance: string;
    source: string;
    summary: string;
    evidence: string;
    severity: BotErrorsSeverity;
    criticalAsset?: BotErrorsCriticalAssetDiagnostic;
    protocol?: BotErrorsProtocolInput;
  },
): AlertEmissionResult {
  // Reuse buildBotErrorsEvent so the captured record is identical-shape AND
  // redacted exactly like a real outbox event — a secret in evidence must never
  // leak to the sink file.
  const { protocol, ...legacyInput } = input;
  const event = buildBotErrorsEvent(withProtocol(legacyInput, protocol));
  appendFileSync(sink, `${JSON.stringify(event)}\n`);
  return { ok: true, channel: 'sink', status: 'durably_queued' };
}

/**
 * Durable alert emission. Writes an atomic local outbox event for the BOT ERRORS
 * dispatcher. Falls back to the legacy helper only if the local write fails.
 */
export function emitAlert(
  instance: string,
  source: string,
  summary: string,
  evidence: string,
  severity: BotErrorsSeverity = 'critical',
  criticalAsset?: BotErrorsCriticalAssetDiagnostic,
  protocol?: BotErrorsProtocolInput,
): AlertEmissionResult {
  const sink = alertSinkPath();
  if (sink) {
    try {
      return captureToAlertSink(sink, {
        eventType: 'alert', instance, source, summary, evidence, severity, criticalAsset, protocol,
      });
    } catch (err) {
      const invalid = protocolValidationFailure(err, instance, source, 'alert');
      if (invalid) return invalid;
      throw err;
    }
  }
  try {
    const legacyInput = { eventType: 'alert' as const, instance, source, summary, evidence, severity, criticalAsset };
    const outbox = writeBotErrorsEvent(withProtocol(legacyInput, protocol));
    return { ok: true, channel: 'outbox', status: 'durably_queued', outbox };
  } catch (err) {
    const invalid = protocolValidationFailure(err, instance, source, 'alert');
    if (invalid) return invalid;
    const reason = errorMessage(err);
    log.warn({ instance, source, err: reason }, 'bot-errors outbox write failed');
    if (isThrottled(instance, source, summary)) {
      return { ok: true, channel: 'legacy', status: 'legacy_accepted_unconfirmed', outboxError: reason };
    }
    const legacy = spawnLegacyAlert(
      ['--instance', instance, '--source', source, '--summary', summary, '--evidence', evidence],
      { instance, source },
      'alert emission failed',
    );
    return {
      ok: legacy.accepted,
      channel: legacy.accepted ? 'legacy' : 'none',
      status: legacy.accepted ? 'legacy_accepted_unconfirmed' : 'failed',
      legacy,
      outboxError: reason,
    };
  }
}

/**
 * Durable clear emission. Clears a source from an open incident.
 */
export function clearAlertSource(
  instance: string,
  source: string,
  evidence = `repair_lane:${instance}`,
  criticalAsset?: BotErrorsCriticalAssetDiagnostic,
  protocol?: BotErrorsProtocolInput,
): AlertEmissionResult {
  const sink = alertSinkPath();
  if (sink) {
    try {
      return captureToAlertSink(sink, {
        eventType: 'clear',
        instance,
        source,
        summary: `alert source cleared: ${source}`,
        evidence,
        severity: 'info',
        criticalAsset,
        protocol,
      });
    } catch (err) {
      const invalid = protocolValidationFailure(err, instance, source, 'clear');
      if (invalid) return invalid;
      throw err;
    }
  }
  try {
    const legacyInput = {
      eventType: 'clear',
      instance,
      source,
      summary: `alert source cleared: ${source}`,
      evidence,
      severity: 'info',
      criticalAsset,
    } as const;
    const outbox = writeBotErrorsEvent(withProtocol(legacyInput, protocol));
    return { ok: true, channel: 'outbox', status: 'durably_queued', outbox };
  } catch (err) {
    const invalid = protocolValidationFailure(err, instance, source, 'clear');
    if (invalid) return invalid;
    const reason = errorMessage(err);
    log.warn({ instance, source, err: reason }, 'bot-errors clear outbox write failed');
    const legacy = spawnLegacyAlert(
      ['--clear', evidence, '--source', source],
      { instance, source },
      'alert clear failed',
    );
    return {
      ok: legacy.accepted,
      channel: legacy.accepted ? 'legacy' : 'none',
      status: legacy.accepted ? 'legacy_accepted_unconfirmed' : 'failed',
      legacy,
      outboxError: reason,
    };
  }
}

export function observeAlertEmission(result: AlertEmissionResult, context: AlertEmissionContext): boolean {
  if (!result.ok) {
    log.warn(
      {
        ...context,
        channel: result.channel,
        status: result.status,
        outboxError: result.outboxError,
        legacyReason: result.legacy?.reason,
        legacyError: result.legacy?.error,
      },
      'bot-errors alert emission failed in every channel',
    );
    return false;
  }

  if (result.channel === 'legacy') {
    log.warn(
      {
        ...context,
        channel: result.channel,
        status: result.status,
        legacyAccepted: result.legacy?.accepted ?? false,
      },
      'bot-errors legacy helper accepted alert; delivery is unconfirmed',
    );
  }

  return true;
}

export function emitAlertChecked(
  instance: string,
  source: string,
  summary: string,
  evidence: string,
  severity: BotErrorsSeverity = 'critical',
  criticalAsset?: BotErrorsCriticalAssetDiagnostic,
  protocol?: BotErrorsProtocolInput,
): boolean {
  return observeAlertEmission(
    emitAlert(instance, source, summary, evidence, severity, criticalAsset, protocol),
    { instance, source, operation: 'alert' },
  );
}

export function clearAlertSourceChecked(
  instance: string,
  source: string,
  evidence = `repair_lane:${instance}`,
  criticalAsset?: BotErrorsCriticalAssetDiagnostic,
  protocol?: BotErrorsProtocolInput,
): boolean {
  return observeAlertEmission(
    clearAlertSource(instance, source, evidence, criticalAsset, protocol),
    { instance, source, operation: 'clear' },
  );
}
