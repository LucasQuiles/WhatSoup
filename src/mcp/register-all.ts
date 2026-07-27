// src/mcp/register-all.ts
// Standalone function that registers all 20 tool modules onto a ToolRegistry.
// Used by AgentRuntime and PassiveRuntime so both get the same tools.
//
// Fail-closed contract (issue #480):
//   - Each per-module registration is wrapped so a thrown error is observable.
//   - Modules carrying core tools (messaging, chat-management, search, etc.) must
//     register successfully. If any of them throws, registerAllTools re-throws
//     after the loop completes so callers see the full failure list.
//   - Optional/vendor-gated modules (e.g. `knowledge` for Pinecone-backed search)
//     are tagged `core: false` — registration failure is logged and skipped, and
//     boot continues with a reduced toolset.
// This replaces the prior log-and-continue behaviour that allowed a half-empty
// registry to ship with a misleading `all tools registered` success log line.

import * as chatManagement from './tools/chat-management.ts';
import * as chatOperations from './tools/chat-operations.ts';
import * as searchTools from './tools/search.ts';
import * as groupTools from './tools/groups.ts';
import * as communityTools from './tools/community.ts';
import * as newsletterTools from './tools/newsletter.ts';
import * as businessTools from './tools/business.ts';
import * as advancedTools from './tools/advanced.ts';
import * as callTools from './tools/calls.ts';
import * as presenceTools from './tools/presence.ts';
import * as profileTools from './tools/profile.ts';
import * as knowledgeTools from './tools/knowledge.ts';
import * as memoryWriteTools from './tools/memory-write.ts';
import * as voiceTools from './tools/voice.ts';
import * as retentionTools from './tools/retention.ts';
import * as statusTools from './tools/status.ts';
import * as schedulingTools from './tools/scheduling.ts';
import * as auditTools from './tools/audit.ts';
import * as substrateTools from './tools/substrate.ts';
import * as messagingTools from './tools/messaging.ts';
import * as mediaTools from './tools/media.ts';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolDeclaration, ExtendedBaileysSocket } from './types.ts';
import type { Database } from '../core/database.ts';
import type { RuntimeConnection } from '../transport/runtime-connection.ts';
import { createProfileRegistry } from '../core/profiles.ts';
import { createOutboundSendsWriter } from '../core/outbound-sends.ts';

const log = createChildLogger('register-all');

export interface RegisterAllToolsOptions {
  enableKnowledgeSearch?: boolean;
  pollRegistrar?: import('./tools/messaging.ts').PollRegistrar;
  /**
   * T8-F2: query whether the runtime is currently in a fallback-provider
   * window, threaded to every MCP send tool that can reach the operator DM
   * (messaging, media) so their T8-F1 elevation stays provider-conditioned.
   * OPTIONAL: PassiveRuntime has no agent/fallback-provider concept at all,
   * so it omits this — messaging/media then fail closed (treat as active,
   * full scrub) rather than silently elevating on an unknown state.
   */
  fallbackActive?: () => boolean;
}

/**
 * Register all 20 tool modules onto the given registry.
 *
 * Preserves the three calling conventions used by the individual modules:
 *   Pattern 1 (options-object): registerMessagingTools, registerMediaTools, registerVoiceTools
 *   Pattern 2 (DB-dependent):   registerChatManagementTools, registerChatOperationTools, registerSearchTools
 *   Pattern 3 (socket+callback): all remaining modules
 */
/**
 * Module registration error captured during a registerAllTools run.
 * `core: true` entries cause registerAllTools to throw an AggregateError after
 * the loop completes; `core: false` entries are logged and tolerated.
 */
interface ModuleRegistrationFailure {
  module: string;
  core: boolean;
  err: unknown;
}

export function registerAllTools(
  registry: ToolRegistry,
  connection: RuntimeConnection,
  db: Database,
  options: RegisterAllToolsOptions = {},
): void {
  const getSock = () => connection.getSocket() as ExtendedBaileysSocket | null;
  const profileRegistry = createProfileRegistry(config.profiles ?? {});
  const outboundSendsWriter = createOutboundSendsWriter({ db: db.raw, line: config.botName });

  const failures: ModuleRegistrationFailure[] = [];

  /**
   * Build a `register` callback bound to the parent module's `core` flag so that
   * a thrown `registry.register(tool)` (typically a duplicate-name collision)
   * propagates correctly to the runModule aggregator.
   *
   * Without this binding, the shared helper would swallow every throw, and a
   * core callback-style module (chat-management, search, groups, ...) could ship
   * with a silently truncated toolset — the residual gap from issue #480 that
   * #510 closes. By re-throwing for core modules and tolerating for optional
   * ones, both registration shapes (module-loop and callback) honour the same
   * fail-closed contract.
   */
  const makeRegister = (moduleName: string, core: boolean) => (tool: ToolDeclaration) => {
    try {
      registry.register(tool);
    } catch (err) {
      if (core) {
        // Core module: re-throw so runModule's catch records the failure and
        // the post-loop aggregator aborts boot with the full failure list.
        log.error({ err, tool: tool.name, module: moduleName }, 'core tool registration failed — aborting module');
        throw err;
      }
      // Optional module: log and continue. The parent module is allowed to
      // register its remaining tools (or simply skip this one).
      log.warn({ err, tool: tool.name, module: moduleName }, 'optional tool registration failed — continuing');
    }
  };

  /**
   * Run a single module's registration. If it throws, classify the failure by
   * `core` and continue with the next module — core failures are aggregated and
   * thrown after the loop so the caller sees every broken module, not just the
   * first one. The module receives a `register` callback bound to its `core`
   * flag so callback-path failures also reach this aggregator (issue #510).
   */
  const runModule = (
    name: string,
    core: boolean,
    fn: (register: (tool: ToolDeclaration) => void) => void,
  ): void => {
    try {
      // QR-017 / #1976: bracket the whole module under its name so every tool
      // it registers — whether via the direct Pattern-1 body or the Pattern-2/3
      // `register` callback — is stamped with `name` as its group. Pure taxonomy
      // metadata; no behaviour change (listTools/call untouched).
      registry.withModule(name, () => fn(makeRegister(name, core)));
    } catch (err) {
      failures.push({ module: name, core, err });
      if (core) {
        log.error({ err, module: name }, 'core tool module failed to register — boot will abort');
      } else {
        log.warn({ err, module: name }, 'optional tool module failed to register — continuing');
      }
    }
  };

  // Pattern 1 — options-object: take ToolRegistry + deps directly. These bypass
  // the callback `register` helper; registry throws inside the module body
  // propagate to runModule's catch directly.
  runModule('messaging', true, () => messagingTools.registerMessagingTools(registry, {
    connection, db: db.raw, profiles: profileRegistry, auditWriter: outboundSendsWriter,
    pollRegistrar: options.pollRegistrar, instanceName: config.botName,
    // T8-F1+F2: dbWrapper + adminPhones (REQUIRED, mirroring substrate.ts's
    // established dbWrapper/adminPhones pattern for LID-aware admin gating)
    // let send/reply/edit/poll resolve isOperatorDmPeer; fallbackActive is
    // OPTIONAL (see RegisterAllToolsOptions) and threaded straight through.
    dbWrapper: db, adminPhones: config.adminPhones,
    internalPeerJids: config.internalPeerJids,
    fallbackActive: options.fallbackActive,
  }));
  runModule('media', true, () => mediaTools.registerMediaTools(registry, {
    connection, db, adminPhones: config.adminPhones,
    internalPeerJids: config.internalPeerJids,
    fallbackActive: options.fallbackActive,
  }));
  runModule('voice', true, () => voiceTools.registerVoiceTools(registry, { connection, db }));
  runModule('retention', true, () => retentionTools.registerRetentionTools(registry, { db }));
  runModule('status', true, () => statusTools.registerStatusTools(registry, { db, getSock }));
  runModule('scheduling', true, () => schedulingTools.registerSchedulingTools(registry, { db }));
  runModule('audit', true, () => auditTools.registerOutboundAuditTools(registry, { writer: outboundSendsWriter }));
  runModule('substrate', true, () => substrateTools.registerSubstrateTools(registry, {
    db: db.raw,
    dbWrapper: db,
    adminPhones: config.adminPhones,
    enableUrlWatch: config.advanced?.enableUrlWatch ?? false,
    memory: config.memory,
  }));

  // Pattern 2 — DB-dependent. The `register` argument is bound to this module's
  // core flag so registry.register throws abort the module (issue #510).
  runModule('chat-management', true, (register) => chatManagement.registerChatManagementTools(db, getSock, register));
  runModule('chat-operations', true, (register) => chatOperations.registerChatOperationTools(db, getSock, register));
  runModule('search', true, (register) => searchTools.registerSearchTools(db, register));

  // Pattern 3 — socket+callback. Same core-aware register binding as Pattern 2.
  runModule('groups', true, (register) => groupTools.registerGroupTools(getSock, register, db));
  runModule('community', true, (register) => communityTools.registerCommunityTools(getSock, register));
  runModule('newsletter', true, (register) => newsletterTools.registerNewsletterTools(getSock, register));
  runModule('business', true, (register) => businessTools.registerBusinessTools(getSock, register));
  runModule('advanced', true, (register) => advancedTools.registerAdvancedTools(getSock, register, db));
  runModule('calls', true, (register) => callTools.registerCallTools(getSock, register));
  runModule('profile', true, (register) => profileTools.registerProfileTools(getSock, db, register));

  // Presence needs the shared presenceCache from ConnectionManager
  runModule('presence', true, (register) => presenceTools.registerPresenceTools(getSock, connection.presenceCache, register));

  // Knowledge search — only when instance config specifies allowed indexes.
  // Vendor-gated (Pinecone): tagged core: false so failure is tolerated.
  const memoryPinecone = (config as {
    memory?: { pinecone?: { allowedIndexes?: string[]; knowledgeSearch?: { enabled?: boolean } } };
  }).memory?.pinecone;
  const allowedIndexes: string[] = Array.isArray(memoryPinecone?.allowedIndexes)
    ? memoryPinecone.allowedIndexes
    : Array.isArray(config.pineconeAllowedIndexes) ? config.pineconeAllowedIndexes : [];
  const knowledgeEnabled = memoryPinecone?.knowledgeSearch?.enabled !== false;
  if (allowedIndexes.length > 0 && knowledgeEnabled && options.enableKnowledgeSearch !== false) {
    runModule('knowledge', false, (register) => knowledgeTools.registerKnowledgeTools(allowedIndexes, register));
  }

  // Memory write — agent-facing episodic WRITE into the configured per-person
  // Pinecone index (agent instances don't run the chat-runtime enrichment poller).
  // Vendor-gated (Pinecone): core: false. Registered whenever a Pinecone API key
  // is available; PineconeMemory.upsert enforces the non-q project guard.
  const memWriteApiKeyEnv =
    (memoryPinecone as { apiKeyEnv?: string } | undefined)?.apiKeyEnv ?? 'PINECONE_API_KEY';
  if (config.pineconeIndex && process.env[memWriteApiKeyEnv]) {
    runModule('memory-write', false, (register) =>
      memoryWriteTools.registerMemoryWriteTools(register),
    );
  }

  // Fail-closed: if any core module threw, abort boot with the full failure list
  // instead of silently shipping a partial toolset.
  const coreFailures = failures.filter((f) => f.core);
  if (coreFailures.length > 0) {
    const moduleNames = coreFailures.map((f) => f.module).join(', ');
    const errs = coreFailures.map((f) => (f.err instanceof Error ? f.err : new Error(String(f.err))));
    log.error(
      { modules: coreFailures.map((f) => f.module), count: coreFailures.length },
      'registerAllTools aborting — one or more core tool modules failed to register',
    );
    throw new AggregateError(
      errs,
      `registerAllTools: core tool module(s) failed to register: ${moduleNames}`,
    );
  }

  log.info(
    {
      toolCount: registry.listTools({ tier: 'global' }).length,
      optionalFailures: failures.filter((f) => !f.core).map((f) => f.module),
    },
    'all tools registered',
  );
}
