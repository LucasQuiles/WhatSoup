import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('emit-alert');
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
let missingScriptWarned = false;

function alertScriptAvailable(): boolean {
  if (existsSync(ALERT_SCRIPT)) return true;
  if (!missingScriptWarned) {
    missingScriptWarned = true;
    log.warn({ script: ALERT_SCRIPT }, 'alert helper script not present; alerts will be silent');
  }
  return false;
}

/**
 * Fire-and-forget alert emission. Spawns whatsapp-alert.sh with stdio: 'ignore'.
 * Never blocks the caller. Never throws. 5-second timeout kills hung scripts.
 */
export function emitAlert(
  instance: string,
  source: string,
  summary: string,
  evidence: string,
): void {
  if (!alertScriptAvailable()) return;
  const child = spawn(
    ALERT_SCRIPT,
    ['--instance', instance, '--source', source,
     '--summary', summary, '--evidence', evidence],
    { stdio: 'ignore', timeout: 5_000, detached: false },
  );
  child.unref();
  child.on('error', (err) => {
    log.warn({ instance, source, err: err.message }, 'alert emission failed');
  });
  child.on('exit', (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (exitCode !== 0 || signal !== null) {
      log.warn({ source, exitCode, signal }, 'alert script exited non-zero or via signal');
    }
  });
}

/**
 * Fire-and-forget clear emission. Clears a source from an open incident.
 */
export function clearAlertSource(instance: string, source: string): void {
  if (!alertScriptAvailable()) return;
  const child = spawn(
    ALERT_SCRIPT,
    ['--clear', `repair_lane:${instance}`, '--source', source],
    { stdio: 'ignore', timeout: 5_000, detached: false },
  );
  child.unref();
  child.on('error', (err) => {
    log.warn({ instance, source, err: err.message }, 'alert clear failed');
  });
  child.on('exit', (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (exitCode !== 0 || signal !== null) {
      log.warn({ source, exitCode, signal }, 'alert script exited non-zero or via signal');
    }
  });
}
