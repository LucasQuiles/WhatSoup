import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const INSTANCE_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 3;

function safeSegment(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return fallback;
  if (!INSTANCE_RE.test(trimmed)) return fallback;
  return trimmed;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function stateRoot() {
  return join(homedir(), '.claude', 'rgp');
}

export function resolveInstanceName(value = process.env.WHATSOUP_INSTANCE) {
  return safeSegment(value, 'default');
}

export function instanceStateDir(instance = resolveInstanceName()) {
  return ensureDir(join(stateRoot(), safeSegment(instance, 'default')));
}

export function sessionStateDir(sessionId) {
  return ensureDir(join(homedir(), '.claude', 'session-env', safeSegment(sessionId, 'unknown-session')));
}

export function stuckRepliesQueuePath(instance = resolveInstanceName()) {
  return join(instanceStateDir(instance), 'stuck-replies.jsonl');
}

export function rateLimitPath(instance = resolveInstanceName()) {
  return join(instanceStateDir(instance), 'fallback-rate-limit.json');
}

export function queueLockPath(instance = resolveInstanceName()) {
  return join(instanceStateDir(instance), 'stuck-replies.lock');
}

export function defaultSocketPath() {
  return join(homedir(), '.claude', 'whatsoup.sock');
}

export function logLine(file, obj) {
  try {
    ensureDir(dirname(file));
    appendFileSync(file, `[${new Date().toISOString()}] ${JSON.stringify(obj)}\n`, { mode: 0o600 });
  } catch {
    // Hook telemetry must never fail the caller path.
  }
}

export function appendQueueEntry(queuePath, entry) {
  try {
    ensureDir(dirname(queuePath));
    appendFileSync(queuePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readQueueRecords(queuePath) {
  if (!existsSync(queuePath)) return { records: [], malformedLines: 0 };
  const text = readFileSync(queuePath, 'utf8');
  const records = [];
  let malformedLines = 0;

  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      records.push({ raw, entry: JSON.parse(raw) });
    } catch {
      malformedLines += 1;
      records.push({ raw, entry: null });
    }
  }

  return { records, malformedLines };
}

export function readQueueEntries(queuePath) {
  const { records, malformedLines } = readQueueRecords(queuePath);
  return {
    entries: records.flatMap((record) => (record.entry === null ? [] : [record.entry])),
    malformedLines,
  };
}

export function rewriteQueueEntries(queuePath, entries) {
  try {
    ensureDir(dirname(queuePath));
    const tmpPath = `${queuePath}.${process.pid}.${Date.now()}.tmp`;
    const body = entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    writeFileSync(tmpPath, body, { mode: 0o600 });
    renameSync(tmpPath, queuePath);
    return true;
  } catch {
    return false;
  }
}

export function ackQueueEntries(queuePath, shouldAck) {
  try {
    const { records, malformedLines } = readQueueRecords(queuePath);
    let removed = 0;
    const keptRecords = [];

    for (const record of records) {
      if (record.entry !== null && shouldAck(record.entry)) {
        removed += 1;
        continue;
      }
      keptRecords.push(record);
    }

    ensureDir(dirname(queuePath));
    const tmpPath = `${queuePath}.${process.pid}.${Date.now()}.tmp`;
    const body = keptRecords.length === 0 ? '' : `${keptRecords.map((record) => (
      record.entry === null ? record.raw : JSON.stringify(record.entry)
    )).join('\n')}\n`;
    writeFileSync(tmpPath, body, { mode: 0o600 });
    renameSync(tmpPath, queuePath);
    return { ok: true, removed, kept: keptRecords.length, malformedLines };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), removed: 0, kept: 0, malformedLines: 0 };
  }
}

export async function withQueueLock(instance, fn, opts = {}) {
  const staleMs = opts.staleMs ?? 60_000;
  const lockPath = queueLockPath(instance);
  let fd = null;
  let acquired = false;

  const acquire = () => {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      closeSync(fd);
      fd = null;
      acquired = true;
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= staleMs) return false;
      unlinkSync(lockPath);
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), recoveredStale: true }));
      closeSync(fd);
      fd = null;
      acquired = true;
      return true;
    }
  };

  try {
    if (!acquire()) return { ok: false, locked: true };
    const result = await fn();
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    if (acquired) {
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

function sanitizeChatKey(chatJid) {
  return String(chatJid).replace(/[^A-Za-z0-9@._-]/g, '_');
}

export function checkAndRecordRateLimit(chatJid, instance = resolveInstanceName(), opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_RATE_LIMIT_MAX;
  const now = opts.now ?? Date.now();
  const path = rateLimitPath(instance);
  let state = {};

  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    state = {};
  }

  const key = sanitizeChatKey(chatJid);
  const list = Array.isArray(state[key]) ? state[key].filter((ts) => now - ts < windowMs) : [];
  if (list.length >= max) {
    return { allowed: false, count: list.length, oldestAgeMs: now - list[0] };
  }

  list.push(now);
  state[key] = list;
  for (const existingKey of Object.keys(state)) {
    state[existingKey] = Array.isArray(state[existingKey])
      ? state[existingKey].filter((ts) => now - ts < windowMs)
      : [];
    if (state[existingKey].length === 0) delete state[existingKey];
  }

  try {
    ensureDir(dirname(path));
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    return {
      allowed: true,
      count: list.length,
      writeErr: err instanceof Error ? err.message : String(err),
    };
  }

  return { allowed: true, count: list.length };
}
