import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import logger, { createChildLogger, flushLogger } from './logger.ts';
import { Database, storeDecryptionFailure } from './core/database.ts';
import { cleanupOldRateLimits, cleanupOldAttempts } from './runtimes/chat/rate-limits-db.ts';
import { deleteOldMessages, getMessagesBySender, getMessageCount, getUnprocessedCount } from './core/messages.ts';
import { processHistoryBatch, type HistoryInput } from './core/history-sync.ts';
import { execFileSync } from 'node:child_process';
import { createConnection } from './transport/factory.ts';
import type { RuntimeConnection } from './transport/runtime-connection.ts';
import { ChatRuntime } from './runtimes/chat/runtime.ts';
import { AgentRuntime } from './runtimes/agent/runtime.ts';
import { consumeIntentionalRestartMarker } from './runtimes/agent/self-restart.ts';
import { emitAlertChecked } from './lib/emit-alert.ts';
import { resolveLatestPluginDir } from './runtimes/agent/plugin-dir-resolver.ts';
import { resolveAgentModel } from './instance-loader.ts';
import { PassiveRuntime } from './runtimes/passive/runtime.ts';
import { PineconeMemory, getPineconeReadiness } from './runtimes/chat/providers/pinecone.ts';
import { createAnthropicProvider } from './runtimes/chat/providers/anthropic.ts';
import { createOpenAIProvider } from './runtimes/chat/providers/openai.ts';
import { MemoryConsolidationScheduler } from './memory/consolidation-scheduler.ts';
import { startHealthServer } from './core/health.ts';
import { checkDegradationSignals } from './core/heal.ts';
import { createIngestHandler } from './core/ingest.ts';
import { toConversationKey } from './core/conversation-key.ts';
import { toPersonalJid, toLidJid } from './core/jid-constants.ts';
import { selectReplayableDms, rememberReplayedId } from './core/admin.ts';
import { DurabilityEngine, sendTracked, drainPendingOutbound } from './core/durability.ts';
import { waitForHistorySyncThenRecover } from './core/post-connect-recovery.ts';
import { seedChatAliases } from './core/chats-resolver.ts';
import { createProfileRegistry } from './core/profiles.ts';
import { createOutboundSendsWriter } from './core/outbound-sends.ts';
import { SqliteIdentityStore } from './core/outbound-identity/store.ts';
import { handleContactsUpsert, handleContactsUpdate } from './core/contacts-sync.ts';
import {
  handleReaction,
  handleReceipt,
  handleChatsUpsert,
  handleChatsUpdate,
  handleChatsDelete,
} from './core/chat-sync.ts';
import { handleLabelsEdit, handleLabelsAssociation, cleanupOrphanedAssociations } from './core/label-sync.ts';
import { handleBlocklistSet, handleBlocklistUpdate } from './core/blocklist-sync.ts';
import { lookupAccess, updateAccess, insertAllowed, seedAutoRespondGroups, resolvePhoneFromJid } from './core/access-list.ts';
import { hydrateLidMappings, upsertLidMapping, mineMessageKey, mineGroupParticipants, reconcileLidMappings, setLidAuthDir } from './core/lid-resolver.ts';
import { isAdminPhone } from './lib/phone.ts';
import { handleGroupsUpsert, handleGroupsUpdate } from './core/group-sync.ts';
import type { Runtime } from './runtimes/types.ts';
import { MediaRetentionTimer } from './core/media-retention.ts';
import { ProcessTmpRetentionTimer, DEFAULT_PROCESS_TMP_RETENTION } from './core/process-tmp-retention.ts';
import { DatabaseRetentionTimer, DEFAULT_DATABASE_RETENTION } from './core/database-retention.ts';
import { persistIntroSentFlag } from './core/intro-sent-config.ts';
import { MessageScheduler } from './core/scheduler.ts';
import { TriggerPoller } from './core/substrate/poller.ts';
import { createPineconeWatchSearch } from './mcp/tools/knowledge.ts';
import { backfillMetrics, collectHourlyMetrics } from './core/metrics-collector.ts';
import { startModelCurrencyMonitor } from './lib/model-advisor.ts';
import { shutdownExitCode } from './main-shutdown-policy.ts';
import { acquireProcessLock, isProcessLockError, releaseProcessLock, type ProcessLockHandle } from './lib/process-lock.ts';
import { createServiceManager } from './fleet/platform.ts';

function resolveTilde(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

const log = createChildLogger('main');
const startedAt = Date.now();
let shutdownInProgress = false;
let memoryConsolidationScheduler: MemoryConsolidationScheduler | null = null;
let lockHandle: ProcessLockHandle | null = null;

// --- Lock file ---

function acquireLock(): void {
  try {
    lockHandle = acquireProcessLock(config.lockPath);
    if (lockHandle.reclaimedPreviousBoot) {
      log.warn({ path: config.lockPath }, 'reclaimed a stale lock left by a previous boot');
    }
    log.info({ path: config.lockPath }, 'lock acquired');
  } catch (err: unknown) {
    if (!isProcessLockError(err)) throw err;
    if (err.reason === 'active') {
      log.fatal({ pid: err.existingPid, path: err.lockPath }, 'another instance is already running');
    } else {
      log.fatal(
        { pid: err.existingPid, path: err.lockPath, reason: err.reason },
        'lock file requires manual removal before startup',
      );
    }
    process.exit(1);
  }
}

function releaseLock(): void {
  if (!lockHandle) return;
  const released = releaseProcessLock(lockHandle);
  if (!released) {
    log.warn({ path: lockHandle.path }, 'lock release skipped because lock file is missing or owned by another process');
  }
  lockHandle = null;
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

if (config.adminPhones.size === 0) {
  log.warn('No admin phones configured — approval requests will not be delivered');
}

const pineconeReadiness = await getPineconeReadiness(config.pineconeIndex);
log.info({
  pineconeIndex: pineconeReadiness.index,
  pineconeReadiness: pineconeReadiness.state,
}, 'pinecone readiness');

// 1. Lock
acquireLock();
// Safety net: release lock even if shutdown() throws or is bypassed
process.on('exit', () => releaseLock());

// 2. Database
// db.open() runs pending schema migrations against config.dbPath (see
// core/database.ts:594+). This makes the process that executes these lines
// the de-facto migration trigger for bot.db. For the primary WhatsApp
// runtime, that means only restarting the matching service can apply a
// new migration to /home/whatsoup/.local/share/whatsoup/instances/primary/bot.db;
// companion instances have separate DBs, and the fleet server
// reads instance DBs read-only (see src/fleet/db-reader.ts) — it does not
// run migrations. Operator runbook: docs/runbooks/mwlab-transcription-pinecone.md
// (operator-gated migration trigger for the enrichment exporter rollout).
const db = new Database(config.dbPath);
db.open();

const seededChatAliases = seedChatAliases(db.raw, config.chatAliases);
if (seededChatAliases > 0) {
  log.info({ count: seededChatAliases }, 'seeded chat aliases');
}
const profileRegistry = createProfileRegistry(config.profiles ?? {});
const outboundSendsWriter = createOutboundSendsWriter({ db: db.raw, line: config.botName });

// 2a. Seed admin phones into access_list for allowlist/open_dm modes.
// INSERT OR IGNORE — existing entries are untouched, only missing ones are added.
if (config.accessMode !== 'self_only') {
  for (const phone of config.adminPhones) {
    insertAllowed(db, 'phone', phone);
  }
}

// 2a-1. Seed declared auto-respond groups into access_list (durable, config-driven
// group grants). Insert-only-when-absent: a deliberate block or pending review is
// never overridden. Makes the auto-respond topology reproducible from source/config
// instead of a per-instance hand-inserted DB row. Gated identically to the
// admin-phone seed: self_only mode rejects all group messages at the policy layer,
// so seeding group rows there is inert state pollution.
if (config.accessMode !== 'self_only') {
  const seededGroups = seedAutoRespondGroups(db, config.autoRespondGroups);
  if (seededGroups > 0) {
    log.info({ count: seededGroups }, 'seeded auto-respond groups');
  }
}

// 2a-2. Hydrate LID↔phone mappings from Baileys filesystem into DB.
// L1.5: also register the auth dir so resolveLid() can fall back to disk on DB miss
// (covers reverse files Baileys writes AFTER startup, e.g. first contact from a new LID).
{
  setLidAuthDir(config.authDir);
  const hydrated = hydrateLidMappings(db, config.authDir);
  if (hydrated > 0) log.info({ count: hydrated }, 'hydrated LID mappings from auth dir');
}

// 2b. Pre-connect recovery — runs synchronously before any connection attempt
const durability = new DurabilityEngine(db);
durability.preConnectRecovery();

// Parse INSTANCE_CONFIG once — used for warm-start import and instance type selection.
let instanceConfig: Record<string, unknown> | null = null;
if (process.env.INSTANCE_CONFIG) {
  try {
    instanceConfig = JSON.parse(process.env.INSTANCE_CONFIG) as Record<string, unknown>;
  } catch {
    throw new Error('INSTANCE_CONFIG is set but is not valid JSON');
  }
}

// Model currency advisories — startup + daily check that configured models are
// still current, with operator notification via BOT_ERRORS when they are not.
// Advisory-only and fail-open; never blocks startup. Symbolic role values
// (`<vendor>:<family>:latest[-stable]`) are re-resolved on every tick and the
// advisory targets the RESOLVED model; the same tick refreshes the live-ID
// cache used by point-of-use resolution. See docs/configuration.md.
startModelCurrencyMonitor(config.botName, {
  conversation: config.models.conversation,
  extraction: config.models.extraction,
  validation: config.models.validation,
  fallback: config.models.fallback,
  agent: resolveAgentModel(instanceConfig),
});

// 2a. Warm-start import: if DB is empty, import from legacy instance DB
{
  const instanceName = instanceConfig?.name as string | undefined;
  if (instanceName) {
    const msgCount = getMessageCount(db);
    if (msgCount === 0) {
      const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share');
      const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
      // Check legacy locations in order of likelihood.
      // The 'q' instance was renamed from 'personal', so also check the old name.
      const legacyNames = instanceName === 'q' ? [instanceName, 'personal'] : [instanceName];
      const legacyPaths: string[] = [];
      for (const name of legacyNames) {
        legacyPaths.push(
          join(xdgData, 'whatsapp-instances', name, 'bot.db'),
          join(xdgConfig, 'whatsapp-instances', name, 'bot.db'),
          join(xdgData, 'whatsoup', name, 'bot.db'),
        );
      }
      legacyPaths.push(join(xdgData, 'whatsapp-bot', 'bot.db'));
      for (const legacyDbPath of legacyPaths) {
        if (existsSync(legacyDbPath)) {
          log.info({ legacyDbPath }, 'warm-start: importing from legacy DB');
          try {
            db.importFromLegacyDb(legacyDbPath);
            log.info({ legacyDbPath }, 'warm-start: import complete');
          } catch (err) {
            log.warn({ err, legacyDbPath }, 'warm-start: import failed (continuing)');
          }
          break;
        }
      }
    }
  }
}

// 3. Instance type selection
const instanceType = (instanceConfig?.type as string | undefined) ?? 'chat';

// 4. Connection
const connectionManager: RuntimeConnection = createConnection(config);

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
    pluginDirs?: string[];
    enabledPlugins?: Record<string, boolean>;
    allowM365Mutations?: boolean;
    autoCompactInputTokens?: number;
  } | undefined;
  const cwdResolved = agentOpts?.cwd ? resolveTilde(agentOpts.cwd) : undefined;
  const agentModel = resolveAgentModel(instanceConfig);
  runtime = new AgentRuntime(db, connectionManager, config.botName, {
    shared: agentOpts?.sessionScope === 'shared',
    sessionScope: agentOpts?.sessionScope as 'single' | 'shared' | 'per_chat' | undefined,
    cwd: cwdResolved,
    configSystemPrompt: instanceConfig?.systemPrompt as string | undefined,
    instructionsPath: agentOpts?.instructionsPath,
    sandbox: agentOpts?.sandbox,
    model: agentModel,
    sandboxPerChat: agentOpts?.sandboxPerChat as boolean | undefined,
    pluginDirs: agentOpts?.pluginDirs?.map(d => {
      const resolved = resolveTilde(d);
      // A pinned plugin version dir (e.g. .../superpowers/5.0.7) disappears
      // after `claude plugin update`; substitute the latest existing sibling.
      const latest = resolveLatestPluginDir(resolved);
      if (latest !== resolved) {
        log.debug({ configured: resolved, resolved: latest }, 'substituted missing plugin dir with latest version sibling');
      }
      return latest;
    }),
    enabledPlugins: agentOpts?.enabledPlugins,
    allowM365Mutations: agentOpts?.allowM365Mutations,
    autoCompactInputTokens: agentOpts?.autoCompactInputTokens,
    // Composition root owns the fleet/systemd binding; inject it so the runtimes
    // layer (which cannot import fleet) can offer the restart_self tool.
    serviceRestarter: createServiceManager(),
  });
} else if (instanceType === 'passive') {
  runtime = new PassiveRuntime(db, connectionManager, {
    name: config.botName,
    paths: instanceConfig?.paths as any,
    socketPath: instanceConfig?.socketPath as string | undefined,
  });
} else {
  // chat (default): create chat-specific providers
  const anthropic = createAnthropicProvider();
  const openai = createOpenAIProvider(
    config.chatOpenAIProviderConfig as { baseUrl?: string; apiKeyService?: string } | undefined,
  );
  const pinecone = new PineconeMemory();
  // Enrichment is queue-backed: the poller enqueues validated facts into
  // `fact_export_queue`. A deployment may provide an external bridge that
  // drains pending rows and writes them to Pinecone; this process only proves
  // queue admission, not remote export. Any instance with a configured
  // pineconeIndex participates, and the bridge owns target index/project
  // routing plus export acknowledgement.
  const enableEnrichment =
    typeof config.pineconeIndex === 'string' && config.pineconeIndex.length > 0;
  if (
    enableEnrichment &&
    config.memory.consolidation.enabled &&
    pineconeReadiness.state === 'ready'
  ) {
    memoryConsolidationScheduler = new MemoryConsolidationScheduler(pinecone, anthropic, {
      intervalMs: config.memory.consolidation.intervalHours * 60 * 60 * 1000,
      lookbackDays: config.memory.consolidation.lookbackDays,
      dryRun: config.memory.consolidation.dryRun,
    });
    memoryConsolidationScheduler.start();
  } else if (config.memory.consolidation.enabled) {
    log.warn({
      enableEnrichment,
      pineconeReadiness: pineconeReadiness.state,
    }, 'memory consolidation enabled but not started');
  }
  runtime = new ChatRuntime(db, connectionManager, pinecone, anthropic, openai, {
    enableEnrichment,
    getBotJid: () => connectionManager.botJid ?? '',
    getBotLid: () => connectionManager.botLid,
    botName: config.botName,
  });
}

// 6. Wire durability to runtime and message handler
runtime.setDurability(durability);

// Self-restart resume: if a fresh intentional-restart marker is present, the
// previous shutdown was a deliberate restart (not a crash). Consume the marker,
// emit an info-severity completion alert with measured downtime, and queue the
// "back online" continuity ping. This is delivered on connect via a DEDICATED,
// un-gated path (see start()) — NOT pendingStartupMessage — because the existing
// startup-notification path is suppressed under toolUpdateMode:'minimal'
// (the live agent's setting) and startupNotifications, whereas a user-requested
// restart must always confirm. Guarded so a failure here never blocks startup.
let selfRestartBackOnline: { chatJid: string; text: string } | null = null;
if (instanceType === 'agent' && runtime instanceof AgentRuntime) {
  try {
    const marker = consumeIntentionalRestartMarker(config.dataRoot);
    if (marker) {
      // Clamp against backward clock skew (NTP correction, VM migration) so the
      // measured downtime never renders as a negative number.
      const downtimeMs = Math.max(0, Date.now() - new Date(marker.timestamp).getTime());
      if (marker.chatJid) {
        selfRestartBackOnline = {
          chatJid: marker.chatJid,
          text: `✅ Back online — restarted to ${marker.reason} (down ${Math.round(downtimeMs / 1000)}s)`,
        };
      }
      emitAlertChecked(
        config.botName,
        'self_restart_completed',
        `intentional restart complete (${marker.code}): ${marker.reason}`,
        `downtime_ms=${downtimeMs}`,
        'info',
      );
    }
  } catch (err) {
    log.warn({ err }, 'self-restart resume check failed; continuing startup');
  }
}

connectionManager.onMessage = createIngestHandler(
  db,
  connectionManager,
  runtime,
  () => connectionManager.botJid ?? '',
  () => connectionManager.botLid,
  durability,
  instanceType,  // pass instance type for passive short-circuit
);

connectionManager.on('chatCleared', (jid: string) => {
  const conversationKey = toConversationKey(jid);
  try {
    const count = db.clearChat(conversationKey);
    log.info({ jid, conversationKey, count }, 'chatCleared: soft-deleted messages');
  } catch (err) {
    log.error({ err, jid, conversationKey }, 'chatCleared: failed to soft-delete messages');
  }
});

connectionManager.on('messageDeleted', (messageIds: string[]) => {
  try {
    const count = db.markMessagesDeleted(messageIds);
    log.info(
      { count, requested: messageIds.length },
      'messageDeleted: soft-deleted revoked messages',
    );
  } catch (err) {
    log.error({ err, messageIds }, 'messageDeleted: failed to soft-delete revoked messages');
  }
});

connectionManager.on('messageEdited', (messageId: string, newContent: string) => {
  try {
    const count = db.markMessageEdited(messageId, newContent);
    log.info(
      { messageId, applied: count > 0 },
      'messageEdited: applied WhatsApp message edit to local store',
    );
  } catch (err) {
    log.error({ err, messageId }, 'messageEdited: failed to apply message edit');
  }
});

connectionManager.on('contactsUpsert', (contacts) => {
  try {
    handleContactsUpsert(db, contacts);
  } catch (err) {
    log.error({ err }, 'contactsUpsert: failed to persist contacts');
  }
});

connectionManager.on('contactsUpdate', (updates) => {
  try {
    handleContactsUpdate(db, updates);
  } catch (err) {
    log.error({ err }, 'contactsUpdate: failed to update contacts');
  }
});

connectionManager.on('reactionReceived', (data) => {
  try {
    handleReaction(db, data);
  } catch (err) {
    log.error({ err }, 'reactionReceived: failed to persist reaction');
  }
});

connectionManager.on('receiptUpdate', (data) => {
  try {
    handleReceipt(db, data);
  } catch (err) {
    log.error({ err }, 'receiptUpdate: failed to persist receipt');
  }
});

connectionManager.on('mediaUpdate', (updates) => {
  log.info({ count: updates.length }, 'media URLs refreshed');
});

connectionManager.on('chatsUpsert', (chats) => {
  try {
    handleChatsUpsert(db, chats as any);
  } catch (err) {
    log.error({ err }, 'chatsUpsert: failed to persist chats');
  }
});

connectionManager.on('chatsUpdate', (updates) => {
  try {
    handleChatsUpdate(db, updates);
  } catch (err) {
    log.error({ err }, 'chatsUpdate: failed to update chats');
  }
});

connectionManager.on('chatsDelete', (jids) => {
  try {
    handleChatsDelete(db, jids);
  } catch (err) {
    log.error({ err }, 'chatsDelete: failed to delete chats');
  }
});

connectionManager.on('historyMessages', (messages) => {
  if (!Array.isArray(messages)) {
    log.warn({ type: typeof messages }, 'historyMessages: expected array');
    return;
  }
  const stats = processHistoryBatch(db, messages as HistoryInput[], log);
  // Deliberately silent for all-noop batches (row already existed at a real
  // content_type): re-syncs on existing history would otherwise spam logs.
  // If you need visibility into empty-batch cadence, move to log.debug.
  if (stats.inserted || stats.upgraded || stats.placeholders || stats.skipped) {
    log.info(stats, 'historyMessages: batch processed');
  }
});

connectionManager.on('jidAliasChanged', (conversationKey, newJid) => {
  try {
    runtime.handleJidAliasChanged?.(conversationKey, newJid);
    upsertLidMapping(db, conversationKey, newJid);
    // Invalidate the contacts directory LID cache so stale resolutions are evicted
    connectionManager.contactsDir.invalidateLidCache();
    log.info({ conversationKey, newJid }, 'jidAliasChanged: updated delivery JID');
  } catch (err) {
    log.error({ err, conversationKey, newJid }, 'jidAliasChanged: failed to update delivery JID');
  }
});

// L3: Mine LID↔phone pairs from message key participant/participantAlt.
// Every inbound group message may carry both addressing forms — this is
// the highest-volume mapping source and catches pairs that L1/L2 miss.
connectionManager.on('lidPairDiscovered', (participant, participantAlt) => {
  try {
    const pair = mineMessageKey(db, participant, participantAlt);
    if (pair) {
      upsertLidMapping(db, pair.lid, pair.phoneJid, 'L3');
      connectionManager.contactsDir.invalidateLidCache();
      log.info({ lid: pair.lid, phoneJid: pair.phoneJid, source: 'L3-message-mining' }, 'new LID mapping from message key');
    }
  } catch (err) {
    log.warn({ err, participant, participantAlt }, 'L3: failed to mine message key LID pair');
  }
});

connectionManager.on('groupsUpsert', (groups) => {
  try {
    handleGroupsUpsert(db, groups as any);
    // L4: Mine LID↔phone from group participant metadata.
    // Groups carry both lid and phoneNumber fields per participant.
    for (const group of groups as any[]) {
      if (group.participants && Array.isArray(group.participants)) {
        const discovered = mineGroupParticipants(db, group.participants);
        if (discovered > 0) {
          connectionManager.contactsDir.invalidateLidCache();
        }
      }
    }
    log.info({ count: groups.length }, 'groupsUpsert: persisted group metadata');
  } catch (err) {
    log.error({ err }, 'groupsUpsert: failed to persist group metadata');
  }
});

connectionManager.on('groupsUpdate', (updates) => {
  try {
    handleGroupsUpdate(db, updates as any);
    log.info({ count: updates.length }, 'groupsUpdate: persisted group updates');
  } catch (err) {
    log.error({ err }, 'groupsUpdate: failed to persist group updates');
  }
});

connectionManager.on('groupJoinRequest', (data) => {
  log.info({ groupJid: data.groupJid, requesterJid: data.requesterJid }, 'groupJoinRequest: join request received');
});

connectionManager.on('groupParticipantsUpdate', (data) => {
  const { groupJid, author, participants, action } = data;
  if (action !== 'add') return;

  // Check if the bot was added to this group
  const botJid = connectionManager.botJid ?? '';
  const botLid = connectionManager.botLid;
  const botAdded = participants.some(
    (p: string) => p === botJid || p === botLid,
  );
  if (!botAdded) return;

  // Check if the person who added the bot is an admin
  const authorPhone = resolvePhoneFromJid(author, db);
  if (!isAdminPhone(authorPhone, config.adminPhones)) {
    log.info({ groupJid, author, authorPhone }, 'bot added to group by non-admin — not auto-allowing');
    return;
  }

  // Admin added the bot — auto-allow the group
  const existing = lookupAccess(db, 'group', groupJid);
  if (existing?.status === 'allowed') {
    log.info({ groupJid }, 'bot added to already-allowed group');
    return;
  }

  if (existing) {
    updateAccess(db, 'group', groupJid, 'allowed');
  } else {
    insertAllowed(db, 'group', groupJid);
  }
  log.info({ groupJid, author }, 'bot added to group by admin — auto-allowed');
});

connectionManager.on('blocklistSet', (blocklist) => {
  try {
    handleBlocklistSet(db, blocklist);
  } catch (err) {
    log.error({ err }, 'blocklistSet: failed to persist blocklist');
  }
});

connectionManager.on('blocklistUpdate', (data) => {
  try {
    handleBlocklistUpdate(db, data);
  } catch (err) {
    log.error({ err }, 'blocklistUpdate: failed to persist blocklist update');
  }
});

connectionManager.on('newsletterReaction', (data) => {
  log.info({ data }, 'newsletterReaction: newsletter reaction received');
});

connectionManager.on('newsletterView', (data) => {
  log.info({ data }, 'newsletterView: newsletter view received');
});

connectionManager.on('newsletterParticipantsUpdate', (data) => {
  log.info({ data }, 'newsletterParticipantsUpdate: newsletter participants updated');
});

connectionManager.on('newsletterSettingsUpdate', (data) => {
  log.info({ data }, 'newsletterSettingsUpdate: newsletter settings updated');
});

connectionManager.on('labelsEdit', (labels) => {
  try {
    handleLabelsEdit(db, labels);
    cleanupOrphanedAssociations(db);
  } catch (err) {
    log.error({ err }, 'labelsEdit: failed to persist labels');
  }
});

connectionManager.on('labelsAssociation', (data) => {
  try {
    handleLabelsAssociation(db, data);
  } catch (err) {
    log.error({ err }, 'labelsAssociation: failed to persist label association');
  }
});

connectionManager.on('decryptionFailure', (data) => {
  try {
    storeDecryptionFailure(db, data);
  } catch (err) {
    log.error({ err, messageId: data.messageId }, 'failed to store decryption failure');
  }
  log.warn({
    messageId: data.messageId,
    sender: data.senderJid,
    chatJid: data.chatJid,
    error: data.errorMessage,
  }, 'decryption failure — stub stored for potential resend');
});

// 7. Health server — delegates enrichment stats to runtime health snapshot
const healthServer = startHealthServer({
  db,
  connectionManager,
  startedAt,
  durability,
  runtime,
  profiles: profileRegistry,
  auditWriter: outboundSendsWriter,
  instanceName: config.botName,
  instanceType: instanceType,
  accessMode: config.accessMode,
  handleAccessDecision: async (subjectType, subjectId, action) => {
    if (action === 'allow' && subjectType === 'phone') {
      // Replay queued DM messages — uses shared selectReplayableDms helper from admin.ts
      // so group exclusion, dedup (replayedIds), and adminReplayMax cap are all applied consistently.
      log.info({ subjectType, subjectId }, 'access: allowed via POST /access — replaying queued messages');
      const jidFormats = [toPersonalJid(subjectId), toLidJid(subjectId)];
      for (const senderJid of jidFormats) {
        const stored = getMessagesBySender(db, senderJid);
        const { toReplay, groupSkipped } = selectReplayableDms(stored, config.adminReplayMax);
        if (groupSkipped > 0) {
          log.info({ subjectId, senderJid, groupSkipped }, 'access replay: skipped group messages');
        }
        for (const msg of toReplay) {
          rememberReplayedId(msg.messageId);
          await runtime.handleMessage({
            messageId: msg.messageId,
            chatJid: msg.chatJid,
            senderJid: msg.senderJid,
            senderName: msg.senderName,
            content: msg.content,
            contentText: msg.contentText ?? null,
            contentType: msg.contentType,
            isFromMe: false,
            // group messages never replay: mentioned ones dispatched at ingest; unmentioned ones must not re-enter as pseudo-DMs
            isGroup: false,
            mentionedJids: [],
            timestamp: msg.timestamp,
            quotedMessageId: msg.quotedMessageId,
            isResponseWorthy: true,
          });
        }
      }
    } else if (action === 'allow' && subjectType === 'group') {
      log.info({ subjectType, subjectId }, 'access: group allowed via POST /access');
    }
    // Block requires no additional action beyond the DB update
  },
  getEnrichmentStats: () => {
    const snap = runtime.getHealthSnapshot();
    const lastRun = (snap.details as Record<string, unknown>)?.enrichmentLastRunAt as string | null ?? null;
    const runtimeDegraded = snap.status === 'degraded' || snap.status === 'unhealthy';
    let unprocessed = 0;
    try {
      unprocessed = getUnprocessedCount(db);
    } catch (err) { log.warn({ err }, 'failed to get enrichment stats'); }
    return { lastRun, unprocessed, runtimeDegraded };
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

// 10. Metrics backfill + hourly aggregation (piggybacks on enrichment cadence)
const metricsBackfillTimeout = setTimeout(() => {
  try {
    backfillMetrics(db);
  } catch (err) { log.error({ err }, 'metrics backfill failed'); }
}, 5_000);

const metricsInterval = setInterval(() => {
  try {
    collectHourlyMetrics(db);
  } catch (err) { log.error({ err }, 'metrics collection failed'); }
}, config.enrichmentIntervalMs);

// 11. Daily retention + hourly rate limit cleanup
const retentionInterval = setInterval(() => {
  try {
    const deleted = deleteOldMessages(db, config.retentionDays);
    if (deleted > 0) log.info({ count: deleted }, 'retention: deleted old messages');
    const rateLimitDeleted = cleanupOldRateLimits(db);
    if (rateLimitDeleted > 0) log.info({ count: rateLimitDeleted }, 'cleaned up old rate limits');
    const attemptsDeleted = cleanupOldAttempts(db);
    if (attemptsDeleted > 0) log.info({ count: attemptsDeleted }, 'cleaned up old llm attempts');
  } catch (err) { log.error({ err }, 'retention cleanup failed'); }
}, 24 * 60 * 60 * 1000);

// 12. Media retention timer — periodic cleanup of tmp/ and cache/ subdirectories
// config.mediaDir resolves to .../media/tmp; base is one level up
const mediaBaseDir = join(config.mediaDir, '..');
const mediaRetentionTimer = new MediaRetentionTimer(mediaBaseDir, db, {
  intervalMs:    config.mediaRetention.intervalHours * 60 * 60 * 1000,
  tempMaxAgeMs:  config.mediaRetention.tempHours     * 60 * 60 * 1000,
  cacheMaxAgeMs: config.mediaRetention.cacheHours    * 60 * 60 * 1000,
});
mediaRetentionTimer.start(config.mediaRetention.intervalHours * 60 * 60 * 1000);

const processTmpRetentionTimer = new ProcessTmpRetentionTimer(
  process.env.TMPDIR ?? join(config.dataRoot, 'tmp'),
  DEFAULT_PROCESS_TMP_RETENTION,
);
processTmpRetentionTimer.start(DEFAULT_PROCESS_TMP_RETENTION.intervalMs);

const databaseRetentionTimer = new DatabaseRetentionTimer(db, DEFAULT_DATABASE_RETENTION);
databaseRetentionTimer.start(DEFAULT_DATABASE_RETENTION.intervalMs);

// 13. Echo timeout checker — sweep submitted ops stuck > 30 s without an echo
const echoTimeoutInterval = setInterval(() => {
  try {
    durability.sweepStaleSubmitted();
  } catch (err) { log.error({ err }, 'echo timeout sweep failed'); }
  // Drain any ops that landed in `pending` between reconnects (BEAD-057).
  // Fire-and-forget, matching this interval's existing style.
  drainPendingOutbound(connectionManager, durability)
    .catch((err) => log.error({ err }, 'echo timeout drain failed'));
}, 10_000);

// 13b. Stuck-inbound reconciler — finalize inbound rows stranded in a
// non-terminal processing_status while the process is live (preConnectRecovery
// only runs at startup). Runs once now (mirrors preConnectRecovery timing) and
// then on a slow interval, so retention can reclaim finalized rows.
try {
  durability.sweepStuckInbound();
} catch (err) { log.error({ err }, 'startup stuck-inbound sweep failed'); }
const stuckInboundInterval = setInterval(() => {
  try {
    durability.sweepStuckInbound();
  } catch (err) { log.error({ err }, 'stuck-inbound sweep failed'); }
}, 15 * 60 * 1000);

// 14. Degradation signal check — detect persistent decryption failures (Type 2)
// Only run on instances that have Q as a control peer (i.e., heal targets like Loops).
// Q itself has controlPeers but no 'q' entry — running the timer on Q would accumulate
// local heal_reports rows and consume valve/single-flight state for no operational benefit.
const degradationInterval = config.controlPeers.has('q') ? setInterval(() => {
  try {
    // runtime.currentControlReportId only exists on AgentRuntime
    const controlReportId = 'currentControlReportId' in runtime
      ? (runtime as any).currentControlReportId as string | null
      : null;
    checkDegradationSignals(db, connectionManager, durability, controlReportId);
  } catch (err) { log.error({ err }, 'degradation signal check failed'); }
}, 60_000) : null;

// 15. L6: Periodic LID reconciliation — re-reads auth dir + finds unresolved LIDs
const lidReconcileInterval = setInterval(() => {
  try {
    const result = reconcileLidMappings(db, config.authDir);
    if (result.hydrated > 0 || result.unresolvedLids.length > 0) {
      log.info({
        hydrated: result.hydrated,
        unresolvedCount: result.unresolvedLids.length,
        unresolvedLids: result.unresolvedLids,
      }, 'L6: LID reconciliation sweep completed');
      if (result.hydrated > 0) connectionManager.contactsDir.invalidateLidCache();
    }
  } catch (err) { log.error({ err }, 'L6: LID reconciliation failed'); }
}, 30 * 60 * 1000); // every 30 minutes

// 16. Message scheduler
const messageScheduler = new MessageScheduler(db, connectionManager, {
  intervalMs: 60_000,   // check every minute
  maxRetries: 3,
});
messageScheduler.recoverStale();
messageScheduler.start();

// 16a. Substrate trigger poller — drains bead_triggers.next_fire_at on a
// 30s interval and dispatches poll.sqlite / poll.pinecone / poll.file /
// poll.url (gated, default-OFF) / schedule.* watches to their report_chat_jid.
// poll.email is recognised but no-op (deferred); event.message is re-homed to
// the ingest path; poll.shell is removed (see src/core/substrate/poller.ts).
//
// poll.pinecone reuses the knowledge_search Pinecone client + index/namespace
// allowlist (no second client). poll.file's allowed-root set is the explicit
// fail-closed allowlist config.memory.fileWatch.allowedRoots (empty = deny-all).
const pineconeWatch = createPineconeWatchSearch(config.memory.pinecone.allowedIndexes);
const triggerPoller = new TriggerPoller(db.raw, connectionManager, {
  pineconeAllowedIndexes: pineconeWatch?.allowedIndexes ?? [],
  pineconeSearch: pineconeWatch?.search,
  fileWatchAllowedRoots: config.memory.fileWatch.allowedRoots,
  // poll.url is gated default-OFF (F2 Slice B). When enabled, the poller fetches
  // through the shared ssrfSafeAgent stack (default urlFetch = fetchUrlGuarded).
  enableUrlWatch: config.advanced.enableUrlWatch,
  // Agent-job dispatch: only the agent runtime can run a turn. On agent
  // instances, a schedule.* fire whose linked bead is an agent_job RUNS the
  // prompt as a turn; on non-agent instances it is left UNSET so such a fire
  // fails CLOSED instead of posting a bare "cron tick" that never runs.
  agentJobDispatch: runtime instanceof AgentRuntime
    ? (jobCtx) => runtime.dispatchAgentJob(jobCtx)
    : undefined,
});
triggerPoller.start();

// 17. Seed contacts directory from message history (so @name mentions work after restart)
{
  // Inject DB into contacts directory so LID→phone resolution works for @mentions
  connectionManager.contactsDir.setDatabase(db);

  connectionManager.setIdentityStore(new SqliteIdentityStore(db.raw), config.outboundIdentityMode);

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

// 14. Connect and start
async function start(): Promise<void> {
  // runtime.start() starts enrichment poller internally
  await runtime.start();
  await connectionManager.connect();

  // Wait for history sync or timeout, then allow echo grace before recovery so
  // echoes from inflight messages can arrive.
  await waitForHistorySyncThenRecover({
    connectionManager,
    recover: async () => {
      durability.postConnectRecovery();
      // Re-send ops that postConnectRecovery reset to `pending` (BEAD-057).
      // Failure-isolated: a drain error must never break startup.
      try {
        await drainPendingOutbound(connectionManager, durability);
      } catch (err) {
        log.error({ err }, 'drainPendingOutbound on post-connect recovery failed');
      }
    },
  });

  log.info('WhatSoup bot started');

  // ── Startup notification ──
  // introSent flag in config: false = send introduction, true = skip.
  // Set to false on creation and re-link. Patched to true after sending.
  // Restarts (agent only): send terse "back online" status ping.
  const adminPhone = [...config.adminPhones][0];
  if (adminPhone && instanceType !== 'passive') {
    const needsIntro = instanceConfig?.introSent === false;

    if (needsIntro) {
      // First boot or re-link — introduce the instance
      // Persist introSent BEFORE sending to prevent duplicate intros if we crash mid-send
      try {
        const cfgPath = join(config.configRoot, 'config.json');
        if (existsSync(cfgPath)) {
          persistIntroSentFlag(cfgPath, true);
        }
      } catch (e) { log.warn({ err: e }, 'failed to persist introSent flag'); }

      const titleName = config.botName.charAt(0).toUpperCase() + config.botName.slice(1);
      const introText = instanceType === 'agent'
        ? `Hey! *${titleName}* is online and ready. I'm an AI agent with tool access — I can research, write code, manage files, and help with tasks. Send me a message to get started.`
        : `Hey! *${titleName}* is online and ready. I'm an AI assistant — send me a message and I'll respond.`;
      setTimeout(() => {
        sendTracked(connectionManager, toPersonalJid(adminPhone), introText, durability, { replayPolicy: 'safe' })
          .then(() => log.info({ chatJid: toPersonalJid(adminPhone) }, 'sent introduction'))
          .catch((err) => log.warn({ err }, 'failed to send introduction'));
      }, 3_000);
    } else if (
      instanceType === 'agent' &&
      runtime instanceof AgentRuntime &&
      config.startupNotifications &&
      config.toolUpdateMode !== 'minimal'
    ) {
      // Agent restart notification (existing behavior)
      const pending = runtime.popStartupMessage();
      const notifyTarget = pending
        ? { chatJid: pending.chatJid, text: pending.text, isResume: true }
        : { chatJid: toPersonalJid(adminPhone), text: '*Agent back online* ✓', isResume: false };
      setTimeout(() => {
        sendTracked(connectionManager, notifyTarget.chatJid, notifyTarget.text, durability, { replayPolicy: 'safe' })
          .then(() => log.info({ chatJid: notifyTarget.chatJid, isResume: notifyTarget.isResume }, 'sent startup notification'))
          .catch((err) => log.warn({ err, chatJid: notifyTarget.chatJid }, 'failed to send startup notification'));
      }, 3_000);
    }
  } else if (!adminPhone) {
    log.warn('no admin phones configured — skipping startup notification');
  }

  // Self-restart back-online ping — delivered regardless of toolUpdateMode /
  // startupNotifications (which suppress the generic startup notice above),
  // because a user-requested restart must always confirm completion. Reuses the
  // same deferred sendTracked pattern; targets the validated originating chat.
  if (selfRestartBackOnline) {
    const resume = selfRestartBackOnline;
    setTimeout(() => {
      sendTracked(connectionManager, resume.chatJid, resume.text, durability, { replayPolicy: 'safe' })
        .then(() => log.info({ chatJid: resume.chatJid }, 'sent self-restart back-online ping'))
        .catch((err) => log.warn({ err, chatJid: resume.chatJid }, 'failed to send self-restart back-online ping'));
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
    clearTimeout(metricsBackfillTimeout);
    clearInterval(metricsInterval);
    clearInterval(retentionInterval);
    mediaRetentionTimer.stop();
    processTmpRetentionTimer.stop();
    databaseRetentionTimer.stop();
    await memoryConsolidationScheduler?.stop();
    clearInterval(echoTimeoutInterval);
    clearInterval(stuckInboundInterval);
    clearInterval(lidReconcileInterval);
    if (degradationInterval) clearInterval(degradationInterval);
    messageScheduler.stop();
    triggerPoller.stop();
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
    // Flush pino-roll transport before exit (async — waits up to 2s)
    await flushLogger();
    process.exit(shutdownExitCode(signal));
  }
}

// --- Signals ---

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  // Stray stream ENOENT on /tmp files — Baileys opened a read stream on a temp file
  // that was cleaned up before the read completed. Non-fatal; demote to warning.
  const errno = err as NodeJS.ErrnoException;
  if (errno.code === 'ENOENT' && errno.path && errno.path.startsWith('/tmp/')) {
    log.warn({ err, path: errno.path }, 'non-fatal ENOENT on temp file — suppressed crash');
    return;
  }

  log.fatal({ err, shutdownInProgress }, 'uncaught exception');
  if (shutdownInProgress) return;  // Don't race with an in-progress shutdown's exit code
  const done = shutdown('uncaughtException');
  setTimeout(() => { log.error('shutdown hung after uncaughtException — forcing exit'); process.exit(1); }, 5_000).unref();
  done.catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ reason, shutdownInProgress }, 'unhandled rejection');
  if (shutdownInProgress) return;  // Don't race with an in-progress shutdown's exit code
  const done = shutdown('unhandledRejection');
  setTimeout(() => { log.error('shutdown hung after unhandledRejection — forcing exit'); process.exit(1); }, 5_000).unref();
  done.catch(() => process.exit(1));
});
// Diagnostic: log actual exit code (uses stderr to avoid writing to closed pino transport)
process.on('exit', (code) => {
  if (code !== 0) process.stderr.write(`exit code ${code}\n`);
});

// --- Go ---

start().catch((err) => {
  log.fatal({ err }, 'failed to start');
  shutdown('startupError').catch(() => process.exit(1));
});
