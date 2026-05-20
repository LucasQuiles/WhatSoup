import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'whatsoup');
const ALERT_THROTTLE_FILE = join(CONFIG_DIR, 'fleet-alert-throttle.json');

export const ALERT_THROTTLE_INTERVAL_MS = 15 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFreshTimestamp(value: unknown, nowMs: number): value is string {
  if (typeof value !== 'string') return false;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && nowMs - timestampMs < ALERT_THROTTLE_INTERVAL_MS;
}

function saveThrottle(entries: Map<string, string>): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  const orderedEntries = Array.from(entries.entries()).sort(([a], [b]) => a.localeCompare(b));
  const payload = JSON.stringify(Object.fromEntries(orderedEntries), null, 2) + '\n';
  const tmpFile = join(CONFIG_DIR, `.fleet-alert-throttle.${process.pid}.${Date.now()}.tmp`);

  try {
    writeFileSync(tmpFile, payload, { mode: 0o600 });
    renameSync(tmpFile, ALERT_THROTTLE_FILE);
    chmodSync(ALERT_THROTTLE_FILE, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best effort cleanup of a failed temp write
    }
    throw err;
  }
}

export function loadAlertThrottle(nowMs = Date.now()): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(ALERT_THROTTLE_FILE, 'utf-8')) as unknown;
    if (!isRecord(parsed)) return new Map();

    const entries = Object.entries(parsed).filter(([, value]) => isFreshTimestamp(value, nowMs)) as Array<[string, string]>;
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export function recordAlertThrottle(name: string, lastAlertAt: string, nowMs = Date.now()): void {
  if (!isFreshTimestamp(lastAlertAt, nowMs)) return;

  const entries = loadAlertThrottle(nowMs);
  entries.set(name, lastAlertAt);
  saveThrottle(entries);
}
