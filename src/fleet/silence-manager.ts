import {
  existsSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createChildLogger } from '../logger.ts';
import { errorMessage } from '../lib/error-message.ts';
import { writeAtomicPrivateFileSync } from '../lib/private-fs.ts';

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
  // #2288 M5: crash-safe atomic write via writeAtomicPrivateFileSync — adds the
  // missing fsync before rename so a crash after rename but before flush cannot
  // leave an empty/truncated silences file (which loadRules would silently
  // treat as "no active silences", re-enabling deliberately suppressed alerts).
  writeAtomicPrivateFileSync(SILENCES_FILE, JSON.stringify(rules, null, 2) + '\n', 'silence rules');
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
