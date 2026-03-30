import { writeFileSync, unlinkSync, openSync, closeSync, readFileSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import logger, { createChildLogger } from './logger.ts';
import { Database } from './core/database.ts';
import { cleanupOldRateLimits } from './runtimes/chat/rate-limits-db.ts';
import { deleteOldMessages } from './core/messages.ts';
import { execFileSync } from 'node:child_process';
import { ConnectionManager } from './transport/connection.ts';
import { ChatRuntime } from './runtimes/chat/runtime.ts';
import { AgentRuntime } from './runtimes/agent/runtime.ts';
import { PineconeMemory } from './runtimes/chat/providers/pinecone.ts';
import { createAnthropicProvider } from './runtimes/chat/providers/anthropic.ts';
import { createOpenAIProvider } from './runtimes/chat/providers/openai.ts';
import { startHealthServer } from './core/health.ts';
import { createIngestHandler } from './core/ingest.ts';
import type { Runtime } from './runtimes/types.ts';

function resolveTilde(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

const log = createChildLogger('main');
const startedAt = Date.now();
let shutdownInProgress = false;

// --- Lock file ---

function acquireLock(): void {
  let fd: number;
  try {
    fd = openSync(config.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'EEXIST') throw err;

    // Lock file exists — check if its owner is still alive
    let existingPid: number | undefined;
    try {
      const raw = readFileSync(config.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid: number; startedAt: string };
      existingPid = parsed.pid;
    } catch {
      // Corrupt lock file — remove and retry
      log.warn({ path: config.lockPath }, 'corrupt lock file, removing and retrying');
      unlinkSync(config.lockPath);
      return acquireLock();
    }

    try {
      process.kill(existingPid, 0);
      // Signal 0 succeeded — process is alive
      log.fatal({ pid: existingPid, path: config.lockPath }, 'another instance is already running');
      process.exit(1);
    } catch (killErr: unknown) {
      const killNodeErr = killErr as NodeJS.ErrnoException;
      if (killNodeErr.code === 'ESRCH') {
        // Process does not exist — stale lock
        log.warn({ pid: existingPid, path: config.lockPath }, 'stale lock file detected, removing and retrying');
        unlinkSync(config.lockPath);
        return acquireLock();
      }
      // EPERM: process exists but we can't signal it — treat as alive
      log.fatal({ pid: existingPid, path: config.lockPath }, 'another instance is already running');
      process.exit(1);
    }
  }

  // Write PID and timestamp into the newly created exclusive file
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  closeSync(fd);
  log.info({ path: config.lockPath }, 'lock acquired');
}

function releaseLock(): void {
  try { unlinkSync(config.lockPath); } catch { /* already gone */ }
}

// --- Bootstrap ---

log.info({
  botName: config.botName,
  pineconeIndex: config.pineconeIndex,
  pineconeSearchMode: config.pineconeSearchMode,
  pineconeRerank: config.pineconeRerank,
  pineconeTopK: config.pineconeTopK,
  accessMode: config.accessMode,
  model: config.models.conversation,
}, 'starting bot');

// 1. Lock
acquireLock();
// Safety net: release lock even if shutdown() throws or is bypassed
process.on('exit', () => releaseLock());

// 2. Database
const db = new Database(config.dbPath);
db.open();

// 2a. Warm-start import: if WhatSoup DB is empty, try importing from legacy whatsapp-bot DB
{
  const instanceConfig = process.env.INSTANCE_CONFIG ? JSON.parse(process.env.INSTANCE_CONFIG) as Record<string, unknown> : null;
  const instanceName = instanceConfig?.name as string | undefined;
  if (instanceName) {
    // Check if we have zero messages (first run)
    const msgCount = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM messages').get() as { cnt: number }).cnt;
    if (msgCount === 0) {
      // Look for legacy whatsapp-bot DB at the old XDG path
      const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share');
      const legacyDbPath = join(xdgData, 'whatsapp-instances', instanceName, 'bot.db');
      if (existsSync(legacyDbPath)) {
        log.info({ legacyDbPath }, 'warm-start: importing from legacy DB');
        try {
          db.importFromLegacyDb(legacyDbPath);
          log.info({ legacyDbPath }, 'warm-start: import complete');
        } catch (err) {
          log.warn({ err, legacyDbPath }, 'warm-start: import failed (continuing)');
        }
      }
    }
  }
}

// 3. Instance type selection
const instanceConfig = process.env.INSTANCE_CONFIG ? JSON.parse(process.env.INSTANCE_CONFIG) : null;
const instanceType: string = instanceConfig?.type ?? 'chat';

// 4. Connection
const connectionManager = new ConnectionManager();

// 5. Runtime — selected by instance type
let runtime: Runtime;
if (instanceType === 'agent') {
  const agentOpts = instanceConfig?.agentOptions as {
    sessionScope?: string;
    cwd?: string;
    instructionsPath?: string;
    sandbox?: {
      allowedPaths: string[];
      allowedTools: string[];
      allowedMcpTools?: string[];
      bash: { enabled: boolean };
    };
    sandboxPerChat?: boolean;
  } | undefined;
  const cwdResolved = agentOpts?.cwd ? resolveTilde(agentOpts.cwd) : undefined;
  runtime = new AgentRuntime(db, connectionManager, config.botName, {
    shared: agentOpts?.sessionScope === 'shared',
    sessionScope: agentOpts?.sessionScope as 'single' | 'shared' | 'per_chat' | undefined,
    cwd: cwdResolved,
    instructionsPath: agentOpts?.instructionsPath,
    sandbox: agentOpts?.sandbox,
    model: instanceConfig?.model,
    sandboxPerChat: agentOpts?.sandboxPerChat as boolean | undefined,
  });
} else {
  // chat (default): create chat-specific providers
  const anthropic = createAnthropicProvider();
  const openai = createOpenAIProvider();
  const pinecone = new PineconeMemory();
  // Disable enrichment for instances using external Pinecone indexes (e.g., besbot)
  const enableEnrichment = config.pineconeIndex === 'whatsapp-bot';
  runtime = new ChatRuntime(db, connectionManager, pinecone, anthropic, openai, { enableEnrichment });
}

// 6. Wire message callback — getters resolve botJid/botLid at dispatch time
connectionManager.onMessage = createIngestHandler(
  db,
  connectionManager,
  runtime,
  () => connectionManager.botJid ?? '',
  () => connectionManager.botLid,
);

// 7. Health server — delegates enrichment stats to runtime health snapshot
const healthServer = startHealthServer({
  db,
  connectionManager,
  startedAt,
  getEnrichmentStats: () => {
    const snap = runtime.getHealthSnapshot();
    const lastRun = (snap.details as Record<string, unknown>)?.enrichmentLastRunAt as string | null ?? null;
    let unprocessed = 0;
    try {
      const row = db.raw.prepare(
        'SELECT COUNT(*) AS cnt FROM messages WHERE enrichment_processed_at IS NULL AND is_from_me = 0',
      ).get() as { cnt: number };
      unprocessed = row.cnt;
    } catch { /* ignore */ }
    return { lastRun, unprocessed };
  },
});

// 8. ffmpeg check
try { execFileSync('which', ['ffmpeg']); } catch { log.warn('ffmpeg not found — video processing will fail'); }

// 9. Initial cleanup (delayed 60s to not block startup)
const startupCleanupTimeout = setTimeout(() => {
  try {
    const deleted = deleteOldMessages(db, config.retentionDays);
    if (deleted > 0) log.info({ count: deleted }, 'retention: deleted old messages');
  } catch (err) { log.error({ err }, 'startup cleanup failed'); }
}, 60_000);

// 10. Daily retention + hourly rate limit cleanup
const retentionInterval = setInterval(() => {
  try {
    const deleted = deleteOldMessages(db, config.retentionDays);
    if (deleted > 0) log.info({ count: deleted }, 'retention: deleted old messages');
    const rateLimitDeleted = cleanupOldRateLimits(db);
    if (rateLimitDeleted > 0) log.info({ count: rateLimitDeleted }, 'cleaned up old rate limits');
  } catch (err) { log.error({ err }, 'retention cleanup failed'); }
}, 24 * 60 * 60 * 1000);

// 11. Seed contacts directory from message history (so @name mentions work after restart)
{
  const rows = db.raw.prepare(
    `SELECT DISTINCT sender_jid, sender_name FROM messages
     WHERE sender_jid IS NOT NULL AND sender_name IS NOT NULL AND sender_name != ''
       AND is_from_me = 0
     ORDER BY timestamp DESC LIMIT 200`,
  ).all() as Array<{ sender_jid: string; sender_name: string }>;
  for (const row of rows) {
    connectionManager.contactsDir.observe(row.sender_jid, row.sender_name);
  }
  if (rows.length > 0) {
    log.info({ contacts: connectionManager.contactsDir.size }, 'contacts directory seeded from message history');
  }
}

// 12. Connect and start
async function start(): Promise<void> {
  // runtime.start() starts enrichment poller internally
  await runtime.start();
  await connectionManager.connect();
  log.info('WhatSoup bot started');

  // Agent instances notify the user on startup (resume or fresh start).
  // Delay 3 s to allow the WA connection to fully stabilise before sending.
  if (instanceType === 'agent' && runtime instanceof AgentRuntime) {
    const pending = runtime.popStartupMessage();
    const notifyTarget = pending
      ? { chatJid: pending.chatJid, text: pending.text, isResume: true }
      : (() => {
          const adminPhone = [...config.adminPhones][0];
          return { chatJid: `${adminPhone}@s.whatsapp.net`, text: '*Agent back online* ✓', isResume: false };
        })();

    setTimeout(() => {
      connectionManager.sendMessage(notifyTarget.chatJid, notifyTarget.text)
        .then(() => log.info({ chatJid: notifyTarget.chatJid, isResume: notifyTarget.isResume }, 'sent startup notification'))
        .catch((err) => log.warn({ err, chatJid: notifyTarget.chatJid }, 'failed to send startup notification'));
    }, 3_000);
  }
}

// --- Shutdown ---

async function shutdown(signal: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  log.info({ signal }, 'shutting down');

  const timeout = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);

  try {
    clearTimeout(startupCleanupTimeout);
    clearInterval(retentionInterval);
    healthServer.close();
    // Flush runtime queue before closing transport so queued messages can be delivered
    // runtime.shutdown() stops enrichment poller internally
    await runtime.shutdown();
    connectionManager.shutdown();
    log.info('shutdown complete');
  } catch (err) {
    log.error({ err }, 'error during shutdown');
  } finally {
    // Always close DB and release lock regardless of shutdown errors
    try { db.close(); } catch (err) { log.error({ err }, 'db.close() failed during shutdown'); }
    releaseLock();
    clearTimeout(timeout);
    // Allow pino to flush
    setTimeout(() => process.exit(0), 200);
  }
}

// --- Signals ---

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  const done = shutdown('uncaughtException').then(() => process.exit(1));
  setTimeout(() => { log.error('shutdown hung after uncaughtException — forcing exit'); process.exit(1); }, 5_000).unref();
  done.catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'unhandled rejection');
  const done = shutdown('unhandledRejection').then(() => process.exit(1));
  setTimeout(() => { log.error('shutdown hung after unhandledRejection — forcing exit'); process.exit(1); }, 5_000).unref();
  done.catch(() => process.exit(1));
});

// --- Go ---

start().catch((err) => {
  log.fatal({ err }, 'failed to start');
  shutdown('startupError').then(() => process.exit(1));
});
