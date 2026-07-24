import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createChildLogger } from '../logger.ts';
import { errorMessage } from '../lib/error-message.ts';

const log = createChildLogger('silence-manager');

const CONFIG_DIR = join(homedir(), '.config', 'whatsoup');
const SILENCES_FILE = join(CONFIG_DIR, 'fleet-silences.json');

export interface SilenceRule {
  instance: string;
  until: string;        // ISO8601
  reason: string;
  silencedBy: string;
  createdAt: string;    // ISO8601
}

function loadRules(): SilenceRule[] {
  try {
    const raw = readFileSync(SILENCES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SilenceRule[];
    // File exists but is not an array — treat as corrupt
    log.warn(
      { file: SILENCES_FILE, err: 'silences file is not a JSON array' },
      'silence file corrupt or invalid — returning empty rules',
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Missing file is normal on first run — silent
    } else {
      log.warn(
        { file: SILENCES_FILE, err: errorMessage(err) },
        'failed to load silence file — returning empty rules',
      );
    }
  }
  return [];
}

function saveRules(rules: SilenceRule[]): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  // Temp-file + atomic rename: a crash or disk-full mid-write must never truncate
  // the live silences file (loadRules would return [] and silently drop all active
  // silences). Matches the pattern in alert-throttle-store.ts and token-storage.ts.
  // See #2166.
  const payload = JSON.stringify(rules, null, 2) + '\n';
  const tmpFile = join(CONFIG_DIR, `.fleet-silences.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpFile, payload, { mode: 0o600 });
    renameSync(tmpFile, SILENCES_FILE);
    chmodSync(SILENCES_FILE, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup of a failed temp write
    }
    throw err;
  }
}

export function isInstanceSilenced(name: string): boolean {
  const now = new Date();
  return loadRules().some(
    (r) => r.instance === name && new Date(r.until) > now,
  );
}

export function listActiveSilences(): SilenceRule[] {
  const now = new Date();
  return loadRules().filter((r) => new Date(r.until) > now);
}

export function addSilence(
  instance: string,
  durationMinutes: number,
  reason: string,
  silencedBy: string,
): SilenceRule {
  const rules = loadRules().filter((r) => r.instance !== instance);
  const now = new Date();
  const until = new Date(now.getTime() + durationMinutes * 60 * 1000);
  const rule: SilenceRule = {
    instance,
    until: until.toISOString(),
    reason,
    silencedBy,
    createdAt: now.toISOString(),
  };
  rules.push(rule);
  saveRules(rules);
  return rule;
}

export function removeSilence(instance: string): boolean {
  const rules = loadRules();
  const filtered = rules.filter((r) => r.instance !== instance);
  if (filtered.length === rules.length) return false;
  saveRules(filtered);
  return true;
}
