import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createChildLogger } from '../logger.ts';
import {
  writeBotErrorsEvent,
  type BotErrorsCriticalAssetDiagnostic,
  type BotErrorsOutboxWrite,
  type BotErrorsSeverity,
} from './bot-errors-outbox.ts';

const log = createChildLogger('emit-alert');
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
let missingScriptWarned = false;
let missingTargetWarned = false;
let invalidTargetWarned = false;
let missingExpectedTargetWarned = false;
let driftedTargetWarned = false;

const GROUP_JID_RE = /^\d+@g\.us$/;

interface LegacyAlertResult {
  attempted: boolean;
  accepted: boolean;
  reason?: string;
  error?: string;
}

export type AlertEmissionStatus = 'durably_queued' | 'legacy_accepted_unconfirmed' | 'failed';

export interface AlertEmissionResult {
  ok: boolean;
  channel: 'outbox' | 'legacy' | 'none';
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
      { stdio: 'ignore', timeout: 5_000, detached: false },
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
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ ...logContext, err: reason }, `${message}; legacy helper failed`);
    return { attempted: true, accepted: false, reason: 'spawn_failed', error: reason };
  }
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
): AlertEmissionResult {
  try {
    const outbox = writeBotErrorsEvent({ eventType: 'alert', instance, source, summary, evidence, severity, criticalAsset });
    return { ok: true, channel: 'outbox', status: 'durably_queued', outbox };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ instance, source, err: reason }, 'bot-errors outbox write failed');
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
): AlertEmissionResult {
  try {
    const outbox = writeBotErrorsEvent({
      eventType: 'clear',
      instance,
      source,
      summary: `alert source cleared: ${source}`,
      evidence,
      severity: 'info',
      criticalAsset,
    });
    return { ok: true, channel: 'outbox', status: 'durably_queued', outbox };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
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
): boolean {
  return observeAlertEmission(
    emitAlert(instance, source, summary, evidence, severity, criticalAsset),
    { instance, source, operation: 'alert' },
  );
}

export function clearAlertSourceChecked(
  instance: string,
  source: string,
  evidence = `repair_lane:${instance}`,
  criticalAsset?: BotErrorsCriticalAssetDiagnostic,
): boolean {
  return observeAlertEmission(
    clearAlertSource(instance, source, evidence, criticalAsset),
    { instance, source, operation: 'clear' },
  );
}
