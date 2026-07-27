import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  const tmpFile = join(CONFIG_DIR, `.fleet-silences.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpFile, JSON.stringify(rules, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmpFile, 0o600);
    renameSync(tmpFile, SILENCES_FILE);
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // intentional: best-effort temp cleanup must not mask the persistence failure being rethrown
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
