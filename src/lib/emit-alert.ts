import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createChildLogger } from '../logger.ts';
import { writeBotErrorsEvent, type BotErrorsSeverity } from './bot-errors-outbox.ts';

const log = createChildLogger('emit-alert');
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
let missingScriptWarned = false;
let missingTargetWarned = false;

function botErrorsJid(): string | null {
  const jid = process.env['BOT_ERRORS_JID']?.trim();
  if (jid) return jid;
  if (!missingTargetWarned) {
    missingTargetWarned = true;
    log.warn({}, 'BOT_ERRORS_JID not configured; legacy alert helper disabled');
  }
  return null;
}

function alertScriptAvailable(): boolean {
  if (existsSync(ALERT_SCRIPT)) return true;
  if (!missingScriptWarned) {
    missingScriptWarned = true;
    log.warn({ script: ALERT_SCRIPT }, 'alert helper script not present; alerts will be silent');
  }
  return false;
}

function spawnLegacyAlert(args: string[], logContext: Record<string, unknown>, message: string): void {
  const target = botErrorsJid();
  if (!target) {
    log.warn(logContext, `${message}; legacy alert target not configured`);
    return;
  }

  if (!alertScriptAvailable()) {
    log.warn(logContext, `${message}; legacy helper script not present`);
    return;
  }

  const child = spawn(
    ALERT_SCRIPT,
    ['--alert-target', target, ...args],
    { stdio: 'ignore', timeout: 5_000, detached: false },
  );
  child.unref();
  child.on('error', (err) => {
    log.warn({ ...logContext, err: err.message }, `${message}; legacy helper failed`);
  });
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
): void {
  try {
    writeBotErrorsEvent({ eventType: 'alert', instance, source, summary, evidence, severity });
    return;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ instance, source, err: reason }, 'bot-errors outbox write failed');
  }

  spawnLegacyAlert(
    ['--instance', instance, '--source', source, '--summary', summary, '--evidence', evidence],
    { instance, source },
    'alert emission failed',
  );
}

/**
 * Durable clear emission. Clears a source from an open incident.
 */
export function clearAlertSource(instance: string, source: string): void {
  try {
    writeBotErrorsEvent({
      eventType: 'clear',
      instance,
      source,
      summary: `alert source cleared: ${source}`,
      evidence: `repair_lane:${instance}`,
      severity: 'info',
    });
    return;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ instance, source, err: reason }, 'bot-errors clear outbox write failed');
  }

  spawnLegacyAlert(
    ['--clear', `repair_lane:${instance}`, '--source', source],
    { instance, source },
    'alert clear failed',
  );
}
