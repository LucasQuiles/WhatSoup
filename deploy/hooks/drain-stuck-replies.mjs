#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ackQueueEntries,
  logLine,
  queueLockPath,
  readQueueEntries,
  resolveInstanceName,
  stuckRepliesQueuePath,
  withQueueLock,
} from './lib/rgp-state.mjs';
import { callTool } from './lib/whatsoup-mcp-call.mjs';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 5_000;

function stateRoot() {
  return join(homedir(), '.claude', 'rgp');
}

function parseArgs(argv) {
  const opts = {
    instance: '',
    ttlMs: DEFAULT_TTL_MS,
    nowMs: Date.now(),
    lockStaleMs: DEFAULT_LOCK_STALE_MS,
    timeoutMs: DEFAULT_SEND_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--instance' && next) {
      opts.instance = resolveInstanceName(next);
      i += 1;
    } else if (arg === '--ttl-ms' && next) {
      opts.ttlMs = Number(next);
      i += 1;
    } else if (arg === '--now-ms' && next) {
      opts.nowMs = Number(next);
      i += 1;
    } else if (arg === '--lock-stale-ms' && next) {
      opts.lockStaleMs = Number(next);
      i += 1;
    } else if (arg === '--timeout-ms' && next) {
      opts.timeoutMs = Number(next);
      i += 1;
    }
  }

  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs < 0) opts.ttlMs = DEFAULT_TTL_MS;
  if (!Number.isFinite(opts.nowMs) || opts.nowMs <= 0) opts.nowMs = Date.now();
  if (!Number.isFinite(opts.lockStaleMs) || opts.lockStaleMs < 0) opts.lockStaleMs = DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) opts.timeoutMs = DEFAULT_SEND_TIMEOUT_MS;
  return opts;
}

function listInstances(instance) {
  if (instance) return [instance];
  const root = stateRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolveInstanceName(entry.name))
      .filter((name, index, names) => name !== 'default' || names[index] === 'default')
      .filter((name, index, names) => names.indexOf(name) === index)
      .filter((name) => existsSync(stuckRepliesQueuePath(name)));
  } catch {
    return [];
  }
}

function isExpired(entry, opts) {
  if (typeof entry.createdAt !== 'string') return false;
  const createdMs = Date.parse(entry.createdAt);
  return Number.isFinite(createdMs) && opts.nowMs - createdMs > opts.ttlMs;
}

function hasSendArgs(entry) {
  return typeof entry.chatJid === 'string'
    && entry.chatJid.trim().length > 0
    && typeof entry.text === 'string'
    && entry.text.trim().length > 0
    && typeof entry.socketPath === 'string'
    && entry.socketPath.trim().length > 0;
}

function entryKey(entry) {
  return typeof entry.id === 'string' && entry.id.trim()
    ? `id:${entry.id}`
    : `entry:${entry.createdAt ?? ''}:${entry.chatJid ?? ''}:${entry.text ?? ''}`;
}

async function drainInstance(instance, opts) {
  const queuePath = stuckRepliesQueuePath(instance);
  const logPath = join(queueLockPath(instance), '..', 'drain-stuck-replies.log');
  if (!existsSync(queuePath)) return { instance, ok: true, sent: 0, expired: 0, kept: 0 };

  const locked = await withQueueLock(instance, async () => {
    const { entries, malformedLines } = readQueueEntries(queuePath);
    const removeKeys = new Set();
    let sent = 0;
    let expired = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const key = entryKey(entry);
      if (entry?.kind !== 'stuck-reply' || entry?.status !== 'queued') {
        skipped += 1;
        continue;
      }
      if (isExpired(entry, opts)) {
        removeKeys.add(key);
        expired += 1;
        continue;
      }
      if (!hasSendArgs(entry)) {
        skipped += 1;
        continue;
      }

      const result = await callTool({
        socketPath: entry.socketPath,
        name: 'send_message',
        args: { chatJid: entry.chatJid, text: entry.text },
        timeoutMs: opts.timeoutMs,
      });
      if (result.ok && result.toolError !== true) {
        removeKeys.add(key);
        sent += 1;
      } else {
        failed += 1;
        logLine(logPath, {
          event: 'send-failed',
          instance,
          entryId: entry.id,
          error: result.error,
          toolError: result.toolError === true,
        });
      }
    }

    const ack = ackQueueEntries(queuePath, (entry) => removeKeys.has(entryKey(entry)));
    logLine(logPath, { event: 'drain-complete', instance, sent, expired, skipped, failed, malformedLines, ack });
    return { instance, sent, expired, skipped, failed, malformedLines, ack };
  }, { staleMs: opts.lockStaleMs });

  if (locked.ok === false && locked.locked) {
    logLine(logPath, { event: 'skip-locked', instance });
    return { instance, ok: true, locked: true, sent: 0, expired: 0, kept: readQueueEntries(queuePath).entries.length };
  }
  if (locked.ok === false) {
    logLine(logPath, { event: 'drain-error', instance, error: locked.error });
    return { instance, ok: false, error: locked.error };
  }
  return { ok: true, ...locked.result };
}

export async function drainStuckReplies(opts = parseArgs(process.argv.slice(2))) {
  const instances = listInstances(opts.instance);
  const results = [];
  for (const instance of instances) {
    results.push(await drainInstance(instance, opts));
  }
  return { ok: results.every((result) => result.ok !== false), instances: results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await drainStuckReplies();
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
