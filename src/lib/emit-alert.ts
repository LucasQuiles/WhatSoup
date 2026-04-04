import { spawn } from 'node:child_process';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('emit-alert');
const ALERT_SCRIPT = '/home/q/.claude/scripts/whatsapp-alert.sh';

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
}

/**
 * Fire-and-forget clear emission. Clears a source from an open incident.
 */
export function clearAlertSource(instance: string, source: string): void {
  const child = spawn(
    ALERT_SCRIPT,
    ['--clear', `repair_lane:${instance}`, '--source', source],
    { stdio: 'ignore', timeout: 5_000, detached: false },
  );
  child.unref();
  child.on('error', (err) => {
    log.warn({ instance, source, err: err.message }, 'alert clear failed');
  });
}
