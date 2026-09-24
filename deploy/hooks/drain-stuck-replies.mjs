#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ackQueueEntries,
  appendQueueEntry,
  expiredRepliesQueuePath,
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
const DEFAULT_MAX_ENTRIES_PER_RUN = 25;

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
    maxEntriesPerRun: DEFAULT_MAX_ENTRIES_PER_RUN,
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
    } else if (arg === '--max-entries' && next) {
      opts.maxEntriesPerRun = Number(next);
      i += 1;
    }
  }

  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs < 0) opts.ttlMs = DEFAULT_TTL_MS;
  if (!Number.isFinite(opts.nowMs) || opts.nowMs <= 0) opts.nowMs = Date.now();
  if (!Number.isFinite(opts.lockStaleMs) || opts.lockStaleMs < 0) opts.lockStaleMs = DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) opts.timeoutMs = DEFAULT_SEND_TIMEOUT_MS;
  if (!Number.isInteger(opts.maxEntriesPerRun) || opts.maxEntriesPerRun <= 0) opts.maxEntriesPerRun = DEFAULT_MAX_ENTRIES_PER_RUN;
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

function expiryStatus(entry, opts) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'createdAt')) return { valid: false, expired: false, reason: 'missing-created-at' };
  if (typeof entry.createdAt !== 'string') return { valid: false, expired: false };
  const createdMs = Date.parse(entry.createdAt);
  if (!Number.isFinite(createdMs) || createdMs > opts.nowMs) return { valid: false, expired: false };
  return { valid: true, expired: opts.nowMs - createdMs > opts.ttlMs };
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
    : `entry:${JSON.stringify([entry.sessionId ?? '', entry.createdAt ?? '', entry.chatJid ?? '', entry.text ?? ''])}`;
}

function expirySourceId(entry) {
  if (typeof entry.id === 'string' && entry.id.trim()) return entry.id.trim();
  if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) return entry.sessionId.trim();
  if (typeof entry.createdAt === 'string' && entry.createdAt.trim()) return entry.createdAt.trim();
  return 'unknown-obligation';
}

function expiryReceipt(entry, instance, opts) {
  return {
    kind: 'stuck-reply-obligation',
    status: 'failed',
    failureClass: 'expired',
    failureCode: 'reply-expired',
    reason: 'queue-ttl-exceeded',
    sourceId: expirySourceId(entry),
    sourceKind: entry.kind,
    sourceCreatedAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
    instance,
    expiredAt: new Date(opts.nowMs).toISOString(),
  };
}

function hasExpiryReceipt(entries, receipt) {
  return entries.some((entry) => (
    entry?.kind === receipt.kind
    && entry?.status === receipt.status
    && entry?.failureCode === receipt.failureCode
    && entry?.sourceId === receipt.sourceId
    && entry?.instance === receipt.instance
  ));
}

async function drainInstance(instance, opts) {
  const queuePath = stuckRepliesQueuePath(instance);
  const logPath = join(queueLockPath(instance), '..', 'drain-stuck-replies.log');
  if (!existsSync(queuePath)) return { instance, ok: true, sent: 0, expired: 0, kept: 0 };

  const locked = await withQueueLock(instance, async () => {
    const queue = readQueueEntries(queuePath);
    if (queue.error) {
      logLine(logPath, { event: 'queue-read-failed', instance, error: queue.error });
      return { instance, ok: false, error: queue.error, sent: 0, expired: 0, kept: 0 };
    }
    const { entries, malformedLines } = queue;
    const removeKeys = new Set();
    let sent = 0;
    let expired = 0;
    let skipped = 0;
    let failed = 0;
    let expiryPersistFailed = 0;
    let malformedEntries = 0;
    let deferred = 0;
    let attempted = 0;
    const expiredPath = expiredRepliesQueuePath(instance);
    const expiryQueue = readQueueEntries(expiredPath);
    if (expiryQueue.error) {
      logLine(logPath, { event: 'expiry-read-failed', instance, error: expiryQueue.error });
      return { instance, ok: false, error: expiryQueue.error, sent: 0, expired: 0, kept: entries.length };
    }

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const key = entryKey(entry);
      if (entry?.kind !== 'stuck-reply' || entry?.status !== 'queued') {
        skipped += 1;
        continue;
      }
      const age = expiryStatus(entry, opts);
      if (!age.valid) {
        malformedEntries += 1;
        failed += 1;
        skipped += 1;
        continue;
      }
      if (!age.expired && !hasSendArgs(entry)) {
        skipped += 1;
        continue;
      }
      if (attempted >= opts.maxEntriesPerRun) {
        deferred += 1;
        continue;
      }
      attempted += 1;
      if (age.expired) {
        const receipt = expiryReceipt(entry, instance, opts);
        const persisted = hasExpiryReceipt(expiryQueue.entries, receipt)
          || appendQueueEntry(expiredPath, receipt);
        if (persisted) {
          expiryQueue.entries.push(receipt);
          removeKeys.add(key);
          expired += 1;
        } else {
          expiryPersistFailed += 1;
          failed += 1;
          logLine(logPath, {
            event: 'expiry-receipt-failed',
            instance,
            entryId: entry.id,
          });
        }
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
    const ok = malformedLines === 0 && malformedEntries === 0 && expiryPersistFailed === 0 && ack.ok;
    logLine(logPath, {
      event: 'drain-complete',
      instance,
      sent,
      expired,
      skipped,
      failed,
      expiryPersistFailed,
      malformedEntries,
      deferred,
      malformedLines,
      ack,
    });
    return { instance, ok, sent, expired, skipped, failed, expiryPersistFailed, deferred, malformedLines, ack };
  }, { staleMs: opts.lockStaleMs });

  if (locked.ok === false && locked.locked) {
    logLine(logPath, { event: 'skip-locked', instance });
    const queue = readQueueEntries(queuePath);
    if (queue.error || queue.malformedLines > 0) {
      return { instance, ok: false, locked: true, error: queue.error ?? 'malformed queue lines', sent: 0, expired: 0 };
    }
    return { instance, ok: true, locked: true, sent: 0, expired: 0, kept: queue.entries.length };
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
