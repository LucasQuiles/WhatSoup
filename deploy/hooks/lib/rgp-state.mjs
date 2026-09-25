import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireProcessLock,
  isProcessLockError,
  releaseProcessLock,
} from '../../../src/lib/process-lock.ts';
import {
  appendPrivateJsonLineSync,
  forceEnsurePrivateDirectorySync,
  writeAtomicPrivateFileSync,
} from '../../../src/lib/private-fs.ts';

const INSTANCE_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 3;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_LINE_BYTES = 4 * 1024;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MUTATION_LOCK_WAIT_MS = 500;
const MUTATION_LOCK_POLL_MS = 10;
const SENSITIVE_DIAGNOSTIC_KEY_RE = /(?:text|content|excerpt|message|error|token|secret|password|credential|transcript|socket|chatjid|jid)/i;

function safeSegment(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return fallback;
  if (!INSTANCE_RE.test(trimmed)) return fallback;
  return trimmed;
}

function ensureDir(dir) {
  forceEnsurePrivateDirectorySync(dir, 'RGP state');
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

export function expiredRepliesQueuePath(instance = resolveInstanceName()) {
  return join(instanceStateDir(instance), 'expired-replies.jsonl');
}

export function rateLimitPath(instance = resolveInstanceName()) {
  return join(instanceStateDir(instance), 'fallback-rate-limit.json');
}

export function queueLockPath(instance = resolveInstanceName()) {
  return join(instanceStateDir(instance), 'stuck-replies.lock');
}

function queueMutationLockPath(queuePath) {
  return join(dirname(queuePath), 'stuck-replies.mutation.lock');
}

export function defaultSocketPath() {
  return join(homedir(), '.claude', 'whatsoup.sock');
}

function sanitizeDiagnosticValue(key, value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (SENSITIVE_DIAGNOSTIC_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitizeDiagnosticValue(key, item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 32).map(([childKey, childValue]) => (
    [childKey, sanitizeDiagnosticValue(childKey, childValue, depth + 1)]
  )));
}

export function logLine(file, obj) {
  try {
    ensureDir(dirname(file));
    const safe = sanitizeDiagnosticValue('', obj);
    let body = `[${new Date().toISOString()}] ${JSON.stringify(safe)}\n`;
    if (Buffer.byteLength(body) > MAX_DIAGNOSTIC_LINE_BYTES) {
      body = `[${new Date().toISOString()}] ${JSON.stringify({
        event: safe?.event ?? 'diagnostic',
        truncated: true,
      })}\n`;
    }
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(body) > MAX_DIAGNOSTIC_BYTES) {
      writeFileSync(file, '', { mode: 0o600 });
    }
    appendFileSync(file, body, { mode: 0o600 });
  } catch {
    // Hook telemetry must never fail the caller path.
  }
}

export function appendQueueEntry(queuePath, entry) {
  let serialized;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    return false;
  }
  if (Buffer.byteLength(`${serialized}\n`, 'utf8') > MAX_QUEUE_BYTES) return false;

  const locked = withMutationLock(queuePath, () => {
    appendPrivateJsonLineSync(queuePath, entry);
    return true;
  });
  return locked.ok && locked.result === true;
}

function readQueueRecords(queuePath) {
  let text;
  try {
    text = readBoundedPrivateText(queuePath, MAX_QUEUE_BYTES, 'queue');
  } catch (err) {
    return {
      records: [],
      malformedLines: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (text === null) return { records: [], malformedLines: 0, error: null };
  const records = [];
  let malformedLines = 0;

  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        malformedLines += 1;
        records.push({ raw, entry: null });
      } else {
        records.push({ raw, entry });
      }
    } catch {
      malformedLines += 1;
      records.push({ raw, entry: null });
    }
  }

  return { records, malformedLines, error: null };
}

export function readQueueEntries(queuePath) {
  const { records, malformedLines, error } = readQueueRecords(queuePath);
  return {
    entries: error ? [] : records.flatMap((record) => (record.entry === null ? [] : [record.entry])),
    malformedLines,
    error,
  };
}

export function rewriteQueueEntries(queuePath, entries) {
  let body;
  try {
    body = entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  } catch {
    return false;
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_QUEUE_BYTES) return false;
  const locked = withMutationLock(queuePath, () => {
    if (readQueueRecords(queuePath).error) return false;
    writeAtomicPrivateFileSync(queuePath, body, 'stuck replies queue', 'required');
    return true;
  });
  return locked.ok && locked.result === true;
}

export function ackQueueEntries(queuePath, shouldAck) {
  const locked = withMutationLock(queuePath, () => {
    const { records, malformedLines, error } = readQueueRecords(queuePath);
    if (error) {
      return { ok: false, error, removed: 0, kept: 0, malformedLines };
    }
    let removed = 0;
    const keptRecords = [];

    for (const record of records) {
      if (record.entry !== null && shouldAck(record.entry)) {
        removed += 1;
        continue;
      }
      keptRecords.push(record);
    }

    const body = keptRecords.length === 0 ? '' : `${keptRecords.map((record) => (
      record.entry === null ? record.raw : JSON.stringify(record.entry)
    )).join('\n')}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_QUEUE_BYTES) {
      return { ok: false, error: `queue replacement exceeds ${MAX_QUEUE_BYTES} bytes`, removed: 0, kept: keptRecords.length, malformedLines };
    }
    try {
      writeAtomicPrivateFileSync(queuePath, body, 'stuck replies queue', 'required');
      return { ok: true, removed, kept: keptRecords.length, malformedLines };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), removed: 0, kept: keptRecords.length, malformedLines };
    }
  });
  if (!locked.ok) {
    return { ok: false, error: locked.error, removed: 0, kept: 0, malformedLines: 0 };
  }
  return locked.result;
}

export async function withQueueLock(instance, fn, opts = {}) {
  const lockPath = queueLockPath(instance);
  let handle;
  try {
    handle = acquireProcessLock(lockPath, { reclaimDeadSameBoot: true });
  } catch (err) {
    if (isProcessLockError(err) && err.reason === 'active') return { ok: false, locked: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let outcome;
  try {
    outcome = { ok: true, result: await fn() };
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    if (!releaseProcessLock(handle)) {
      return { ok: false, error: 'queue lock ownership could not be verified during release' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return outcome;
}

function withMutationLock(queuePath, fn) {
  const lockPath = queueMutationLockPath(queuePath);
  let handle;
  try {
    ensureDir(dirname(queuePath));
    handle = acquireProcessLock(lockPath, {
      reclaimDeadSameBoot: true,
      wait: { timeoutMs: MUTATION_LOCK_WAIT_MS, pollMs: MUTATION_LOCK_POLL_MS },
    });
  } catch (err) {
    const reason = isProcessLockError(err) ? ` (${err.reason})` : '';
    return { ok: false, error: `queue mutation lock unavailable${reason}` };
  }

  let outcome;
  try {
    outcome = { ok: true, result: fn() };
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    if (!releaseProcessLock(handle)) {
      return { ok: false, error: 'queue mutation lock ownership could not be verified during release' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return outcome;
}

function readBoundedPrivateText(file, maxBytes, label) {
  ensureDir(dirname(file));
  let fd = null;
  try {
    const flags = constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0);
    try {
      fd = openSync(file, flags);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user`);
    }
    fchmodSync(fd, 0o600);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    if (fd !== null) closeSync(fd);
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
