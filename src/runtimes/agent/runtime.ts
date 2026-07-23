// src/runtimes/agent/runtime.ts
// AgentRuntime implements the Runtime interface, tying all agent components together.

import type { AgentCommandRequest, AgentCommandResult, Runtime, RuntimeTurnCapabilityHealth } from '../types.ts';
import type { ContentType, IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import type {
  DurabilityEngine,
  SessionCheckpointRow,
} from '../../core/durability.ts';
import type { TurnRecoveryClaimFence, TurnRecoveryJobRow } from '../../core/turn-recovery-store.ts';
import type {
  TurnRecoveryDispatchTarget,
  TurnRecoveryReplayAbortControl,
  TurnRecoverySupervisor,
  TurnRecoveryReplayDispatchResult,
} from './turn-recovery-supervisor.ts';
import { createTurnRecoverySupervisorForRuntime, dispatchTurnRecoveryReplayForJob, shutdownTurnRecoverySupervisorSafely, getTurnRecoveryHealthDetails } from './turn-recovery-dispatch.ts';
import { TurnRecoveryDeadman } from './turn-recovery-deadman.ts';
import { splitInputTokenUsage, type AgentEvent } from './stream-parser.ts';
import {
  classifyProviderFailure,
  classifyStreamedProviderFailure,
  detectAutoSwitchNotice,
  isProviderAuthRequiredMessage,
  MAX_STREAMED_BANNER_LENGTH,
  type ProviderFailureKind,
} from './failure-taxonomy.ts';
import {
  workflowForProviderText,
  type ResponseWorkflow,
  type UserTemplateId,
} from './response-registry.ts';
import { autoSwitchNoticeMessage, renderUserMessage, providerUnknownTerminalNotice } from './response-templates.ts';
import { runDiagnosticBundle } from './diagnostic-bundle.ts';
import { buildDiagnosticProbes } from './diagnostic-probes.ts';
import {
  ensureStandbyNoticeSchema,
  clearStandbyNotice,
} from './standby-notice.ts';
import {
  stashHandoffNotice as stashHandoffNoticeImpl,
  withHandoffPrefix as withHandoffPrefixImpl,
  flushPendingHandoffNotice as flushPendingHandoffNoticeImpl,
} from './handoff-notice-prefix.ts';
import { providerPreview } from './provider-preview-sanitizer.ts';
import { formatContextLines } from './context-lines.ts';
import { redactHandoffPii } from './handoff-pii-redactor.ts';
import { seamForProvider } from './handoff-seam-routing.ts';
import { ensureHandoffArtifactSchema, getHandoffArtifact, deleteHandoffArtifact } from './handoff-artifact.ts';
import { buildHandoffPrelude } from './handoff-prelude.ts';
import type { AgentProvider } from './providers/types.ts';
import { triggerSelfRestart, assertRestartSelfAdmin, type ServiceRestarter } from './self-restart.ts';
import { registerRuntimeInlineTools } from './runtime-tool-registrations.ts';
import { dequeueNextReport, emitHealReport, parseHealContext } from '../../core/heal.ts';
import { allowlistedHealCrashClass, errorClassForHealEvidence } from '../../core/heal-evidence.ts';
import { sendTracked } from '../../core/durability.ts';
import { classifyErrorForInbound } from '../../core/inbound-failure-class.ts';
import {
  normalizeFallbackEntriesFromAgentOptions,
  type AgentFallbackEntry,
} from '../../core/fallback-chain.ts';
import {
  ProviderDataPolicyError,
  providerRoutePolicyKey,
  resolveProviderRoutePolicy,
  type ProviderBoundaryMode,
  type ProviderDataPolicy,
} from '../../core/provider-data-policy.ts';
import {
  createReplyGuaranteeLivenessSender,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
  ReplyGuaranteeManager,
} from '../../core/reply-guarantee.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../lib/emit-alert.ts';
import { lookupCredential, resolveProviderKeyService } from '../../lib/keyring.ts';
import { MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../../lib/time-units.ts';
import { resolveProviderCredentialState, isProviderRoutable, spawnFailureCredentialNote } from '../../lib/provider-credential-eligibility.ts';
import { createChildLogger } from '../../logger.ts';
import {
  ensureAgentSchema,
  getActiveSession,
  backfillWorkspaceKeys,
  markOrphaned,
  getResumableSessionForChat,
  accumulateSessionTokens,
  insertTokenEvent,
  accumulateTokensWithEvent,
  backfillSessionProvider,
  getSessionTokenSnapshot,
  markSessionCompacted,
} from './session-db.ts';
import { reconcileResidentSessionStatuses } from './resident-session-reconciler.ts';
import {
  ensureFallbackStateSchema,
  saveFallbackState,
  getFallbackState,
  clearFallbackState,
} from './fallback-state-db.ts';
import { chatJidToWorkspace, provisionWorkspace, writeSandboxArtifacts, ensurePermissionsSettings } from '../../core/workspace.ts';
import { inspectUserClaudeSettings } from '../../core/user-claude-settings.ts';
import { isSamePhysicalDirectory } from '../../lib/home-path.ts';
import { classifyActiveSessions, resolveAmbiguousAgeFallback } from './session-classifier.ts';
import {
  SessionManager,
  buildChildEnv,
  formatAge,
  getProviderBinary,
  type SessionCrashInfo,
} from './session.ts';
import { createProviderExecutionGate, ProviderExecutionGate } from './provider-execution-gate.ts';
import { dispatchProviderTurn, withProviderApplicationContext } from './provider-boundary-dispatch.ts';
import { TurnChronologyTracker, type TurnDeliveryKind } from './turn-chronology.ts';
import { receivedAtUnixSeconds, renderPendingReplay, renderUserTurnForProvider,
  sharedReplayApplicationContext, sharedRuntimeApplicationContext } from './turn-provider-text.ts';
import { markDeferredSystemTurn, requireSystemTurnProviderBoundary } from './system-turn-deadline.ts';
import {
  OutboundQueue,
  type IOutboundQueue,
  type ToolUpdate,
  type ToolCategory,
} from './outbound-queue.ts';
import { ControlQueue } from './control-queue.ts';
import { classifyInput } from './commands.ts';
import { renderHelp, renderHelpDetail } from './help-render.ts';
import {
  ensureChatPreferenceSchema,
  getPreference,
  setPreference,
  pruneExpired,
  getLatestChatPreference,
  clearChatPreference,
  type ChatModelPreference,
  type PreferenceIntent,
} from './chat-preference-db.ts';
import { preferenceKeys } from './preference-keys.ts';
import { applyRouteEffort, isPinnedModelEligible, resolveRoute, type RouteDecision } from './route-resolution.ts';
import { decideModelPinResolution } from './config-surface.ts';
import type { fetchAnthropicModelIdsWithStatus } from '../../lib/model-advisor.ts';
import { deriveChatScope, emitRouteEvent, type ModelRouteEvent } from './route-events.ts';
import { buildRoutingPromptContract, extractRouteIntents } from './route-intent.ts';
import { createCatalogueSnapshotCache, type CatalogueSnapshotCache } from './model-snapshot-cache.ts';
import { tiersConfigured as modelTiersConfigured } from './model-catalogue-render.ts';
import {
  handleModelCommand, tryHandleBareKeep,
  applyRouteChangeAndRecycle as applyRouteChangeAndRecycleForPort,
  consumePendingRecycleIfIdle as consumePendingRecycleIfIdleForPort,
  PREFERENCE_TTL_MS,
  type ModelPinPort,
  type RouteRecycleOutcome,
} from './model-pin.ts';
import { RouteRecycleLifecycle } from './route-recycle-lifecycle.ts';
import {
  runKillSessionCommand,
  runSessionsCommand,
  shutdownOwnedSessions,
  type RuntimeSessionLifecycleHost,
} from './runtime-session-lifecycle.ts';
import {
  resolveExecutingActor as resolveExecutingActorForPort,
  derivePerChatSocketPath as derivePerChatSocketPathForPort,
  usesPerChatActorSocket as usesPerChatActorSocketForPort,
  createPerChatActorSocket as createPerChatActorSocketForPort,
  wirePerChatActorSocket as wirePerChatActorSocketForPort,
  teardownPerChatActorSocket as teardownPerChatActorSocketForPort,
  exposedCliProviders as exposedCliProvidersForPort,
  perChatActorRaceExposed as perChatActorRaceExposedForPort,
  findMapKeyForSession as findMapKeyForSessionForPort,
  getQueueForChat as getQueueForChatForPort,
  createOperationTracker as createOperationTrackerForPort,
  getTracker as getTrackerForPort,
  sendDirect as sendDirectForPort,
  type ChatTransportPort,
} from './chat-transport.ts';
import { getRecentMessages, getMessagesSince, hasFromMeReplyAfter } from '../../core/messages.ts';
import { toConversationKey, isGroupConversationKey, GLOBAL_CONVERSATION_KEY } from '../../core/conversation-key.ts';
import { bulletedSection, savedPreferenceLine } from './owner-render-format.ts';
import { classifyAssistantTextEgress } from '../../core/outbound-message-safety.ts';
import { resolveConfiguredAdminJid, toPersonalJid, isGroupJid } from '../../core/jid-constants.ts';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { canonicalizeChatJid } from '../../core/lid-resolver.ts';
import { TurnQueue, type QueuedTurn, type TurnRejectReason } from './turn-queue.ts';
import {
  markRuntimeTurnReplayUnsafe,
  type RuntimeTurnContext,
} from './runtime-turn-context.ts';
import { resolveResumeIdentity, type PersistedResumeIdentity } from './resume-identity.ts';
import type { FinalizeRuntimeTurnResult } from './turn-finalizer.ts';
import { runtimeTurnRecoveryIsDegraded, RuntimeTurnSupervisor } from './runtime-turn-supervisor.ts';
import { CrashTracker } from './crash-tracker.ts';
import { AutoCompactController, AUTO_COMPACT_RAPID_REARM_WINDOW_MS } from './auto-compact-controller.ts';
import { ImageCoalescer } from './image-coalescer.ts';
import {
  PendingSystemResultTracker,
  type PendingSystemTurnOwner,
  type PendingSystemTurnSnapshot,
  type SystemTurnPurpose,
  type SystemTurnLeaseToken,
} from './pending-system-result-tracker.ts';
import {
  decideProviderEventAdmission,
  systemPurposeAllowsOutput,
  type ProviderEventOwner,
} from './runtime-event-admission.ts';
import {
  handleProviderFailureResult as handleProviderFailureResultWithPort,
  handleGlobalRuntimeResult,
  handleScopedRuntimeResult,
  type ProviderFailureResultContext,
  type ProviderFallbackActivation,
  type ProviderFallbackReason,
  type RuntimeResultHandlerPort,
} from './runtime-turn-result-handler.ts';
import {
  FallbackReplayInvalidatedError,
  RuntimeTurnCoordinator,
  RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS,
  type PerChatRuntimeScopeRef,
  type ProviderFallbackReplayArgs,
  type ResolvedReplayRoute,
  type RuntimeTurnAfterTerminalAction,
  type RuntimeTurnCompletion,
  type RuntimeTurnCoordinatorPort,
  type RuntimeTurnPostEffects,
  type RuntimeTurnQueueTeardown,
  type RuntimeTurnSourceSnapshot,
} from './runtime-turn-coordinator.ts';
import { TurnCapabilityTracker, type TurnCapabilityErrorClass } from './turn-capability-tracker.ts';
import { SessionOwnershipRegistry } from './session-ownership.ts';
import { killSessionTree } from './process-tree.ts';
import { FallbackWindowMetrics } from './fallback-window-metrics.ts';
import { FallbackWindowState } from './fallback-window-state.ts';
import { FallbackChain } from './fallback-chain-state.ts';
import { FallbackEmptyAdvance } from './fallback-empty-advance.ts';
import { PendingPollStore } from './pending-poll-store.ts';
import { PendingPollPersistence } from './pending-poll-persistence.ts';
import { HandoffDistillCoordinator } from './handoff-distill-coordinator.ts';
import { handoffDistillerEnabled, handoffContextEnabled, handoffDistillModel } from './handoff-distill-config.ts';
import { config } from '../../config.ts';
import type { StartupNotificationEvent } from '../../core/startup-notification-controller.ts';
import {
  checkAndRecordInterruptedBoot,
  markBootInProgress,
  readRestartLoopGuardHealth,
  restartLoopGuardPath,
} from './restart-loop-guard.ts';
import { canonicalConversationKey, resolvePhoneFromJid, resolvePhoneFromJidForGrant } from '../../core/access-list.ts';
import { isAdminPhone } from '../../lib/phone.ts';
import { getCommandSpec } from './command-registry.ts';
import { matchImperative, extractImperativeTarget } from '../../core/substrate/inline-extractor.ts';
import { createBead } from '../../core/substrate/beads.ts';
import { mkdirSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EgressProxy } from './egress-proxy.ts';
import { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
    const sessionProvider = route ? route.provider : this.effectiveProvider;
    const mcpServerScript = resolve(
      new URL('.', import.meta.url).pathname,
      '../../../deploy/mcp/whatsoup-proxy.ts',
    );
    const perChatWire = this.wirePerChatActorSocket(opts.chatJid, sessionProvider);
    const mcpSocketPath = opts.mcpSocketPath ?? perChatWire?.mcpSocketPath;
    const providerTransitionReady = perChatWire?.providerTransitionReady;
    const actorSocketRequired =
      this.sessionScope === 'per_chat' &&
      !this.sandboxPerChat &&
      isProviderId(sessionProvider) &&
      mcpModeForProvider(sessionProvider) === 'stdio_proxy';
    if (actorSocketRequired && (!mcpSocketPath?.trim() || !providerTransitionReady)) {
      throw new Error(`per_chat ${sessionProvider} session for ${conversationKey} would spawn without an actor-bound socket`);
    }
    const providerToolSession: SessionContext =
      this.sandboxPerChat || this.sessionScope === 'per_chat'
        ? {
            tier: 'chat-scoped',
            conversationKey,
            deliveryJid: opts.chatJid,
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(opts.cwd ? { allowedRoot: opts.cwd } : {}),
          }
        : {
            tier: 'global',
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(!this.shared ? { conversationKey } : {}),
        };
    if (opts.trackSingletonMcpSession) {
      this.singletonProviderToolSession = providerToolSession;
    }

    const session = new SessionManager({
      db: this.db,
      messenger: this.messenger,
      chatJid: opts.chatJid,
      onEvent: opts.onEvent,
      instanceName: this.instanceName,
      onResumeFailed: opts.onResumeFailed,
      onCrash: opts.onCrash,
      notifyUser: opts.notifyUser,
      cwd: opts.cwd,
      configRoot: this.sandboxPerChat && opts.cwd ? join(opts.cwd, '.agent-home') : undefined,
      configSystemPrompt: this.configSystemPrompt,
      instructionsPath: this.instructionsPath,
      model: route.model,
      pluginDirs: this.pluginDirs,
      allowM365Mutations: this.allowM365Mutations,
      provider: route ? route.provider : this.effectiveProvider,
      providerConfig: opts.providerConfigOverride
        ? { ...(route ? this.routeSessionProviderConfig(route) : this.sessionProviderConfig()), ...opts.providerConfigOverride }
        : (route ? this.routeSessionProviderConfig(route) : this.sessionProviderConfig()),
      mcpBridge: createProviderMcpBridge(this.registry, providerToolSession),
      mcpSessionContext: providerToolSession,
      whatsoupInstance: this.instanceName,
      whatsoupMcpSocket: mcpSocketPath ?? this.globalMcpSocketPath ?? undefined,
      providerTransitionReady,
      handoffSystemBlock: this.buildHandoffSystemBlock(conversationKey, route ? route.provider : this.effectiveProvider),
      routingSystemBlock: config.nlRouting ? () => this.buildRoutingContractBlock(route ? route.provider : this.effectiveProvider) : undefined,
      egressProxyPort: this.egressProxy?.port,
      providerExecutionGate: this.providerExecutionGate,
      providerMcpConfigArgs: this.globalMcpSocketPath
        ? buildProviderMcpConfigArgs(
            sessionProvider,
            opts.cwd ?? this.cwd ?? homedir(),
            this.globalMcpSocketPath,
            mcpServerScript,
          )
        : [],
      providerCanaryAdmission: actorSocketRequired
        ? () => {
            const admission = readProviderCanaryAdmission({
              providerId: sessionProvider,
              binary: getProviderBinary(sessionProvider) ?? '',
              proxyScriptPath: mcpServerScript,
              stateRoot: config.stateRoot,
              sessionScope: this.sessionScope,
              sandboxPerChat: this.sandboxPerChat,
            });
            if (!admission.allowed) {
              throw new Error('provider MCP canary proof unavailable');
            }
          }
        : undefined,
    });
    this.sessionManagerIds.set(session, randomUUID());
    this.sessionEventToolScopes.set(
      session,
      opts.eventToolScopeKey ?? GLOBAL_TOOL_SCOPE_KEY,
    );
    if (this.durability) {
      session.setDurability(this.durability);
    }
    return session;
  }

  private cleanupFailedSandboxWorkspace(workspaceKey: string): void {
    const queue = this.chatQueues.get(workspaceKey);
    if (queue) {
      try {
        queue.abortTurn();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to abort queued turn during workspace cleanup');
      }
      this.chatQueues.delete(workspaceKey);
    }

    this.deleteOwnedPerChatSession(workspaceKey);
    this.cleanupPerChatState(workspaceKey);

    const res = this.workspaceResources.get(workspaceKey);
    if (!res) return;

    if (res.socketServer) {
      try {
        res.socketServer.stop();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to stop socket server during workspace cleanup');
      }
    }
    if (res.mediaBridge) {
      try {
        res.mediaBridge();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to stop media bridge during workspace cleanup');
      }
    }

    this.workspaceResources.delete(workspaceKey);
  }

  /**
   * Async variant of session/queue initialization for sandboxPerChat mode.
   * Called only when sandboxPerChat=true so the async/await overhead doesn't
   * affect the microtask ordering of existing non-sandboxPerChat tests.
   */
  private async ensureSessionAndQueue(chatJid: string, actorJid?: string): Promise<void> {
    // sandboxPerChat: each chat gets an isolated workspace; map keyed by workspaceKey
    const { workspaceKey, workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);

    if (!this.chatSessions.has(workspaceKey)) {
      try {
        // Provision workspace (deterministic rewrite of control files)
        const hookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/agent-sandbox.sh');
        const pollLintHookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/poll-interaction-lint.mjs');
        const postToolUseLogHookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/post-tool-use-log.sh');
        const mcpServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/whatsoup-proxy.ts');
        const sendMediaServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/send-media-server.ts');
        const chatScopedToolNames = this.registry.getChatScopedToolNames();
        const providerConfig =
          this.effectiveProvider === 'opencode-cli' && this.effectiveFallbackEntry === null
            ? this.primaryOpencodeProviderConfig()
            : undefined;
        const socketPath = provisionWorkspace({
          workspacePath,
          instanceCwd: this.cwd ?? homedir(),
          provider: this.effectiveProvider,
          providerConfig,
          sandbox: this.sandbox!,
          hookPath,
          pollLintHookPath,
          postToolUseLogHookPath,
          mcpServerPath,
          sendMediaServerPath,
          chatScopedToolNames,
        });

        // Start chat-scoped WhatSoup socket server + media bridge for this workspace if not already running
        if (!this.workspaceResources.has(workspaceKey)) {
          let socketServer: WhatSoupSocketServer | null = null;
          let mediaBridge: MediaBridge | null = null;
          try {
            const chatSession: SessionContext = {
              tier: 'chat-scoped',
              conversationKey: workspaceKey,
              deliveryJid: chatJid,
              ...(actorJid ? { actorJid } : {}),
              allowedRoot: workspacePath,
            };
            socketServer = new WhatSoupSocketServer(socketPath, this.registry, chatSession);
            socketServer.start();
            log.info({ socketPath, workspaceKey }, 'chat-scoped WhatSoup socket server started');
          } catch (err) {
            log.warn({ err, socketPath }, 'failed to start WhatSoup socket server for workspace');
          }

          // Start media bridge — allows Claude Code subprocess to send media via Unix socket.
          // The bridge socket lives at .claude/media-bridge.sock alongside whatsoup.sock.
          const mediaBridgeSocketPath = join(workspacePath, '.claude', 'media-bridge.sock');
          try {
            mediaBridge = startMediaBridge(mediaBridgeSocketPath, this.messenger, workspacePath);
            setMediaBridgeChat(mediaBridge, chatJid);
            log.info({ mediaBridgeSocketPath, workspaceKey }, 'media bridge started');
          } catch (err) {
            log.warn({ err, mediaBridgeSocketPath }, 'failed to start media bridge for workspace');
          }

          this.workspaceResources.set(workspaceKey, {
            socketPath,
            workspacePath,
            socketServer,
            mediaBridge,
            lastActivity: Date.now(),
          });
        }

        // Create SessionManager with workspace-scoped cwd
        const toolScopeKey = this.createToolScopeKey(workspaceKey);
        let session!: SessionManager;
        session = this.createSessionManager({
          chatJid,
          cwd: workspacePath,  // scoped cwd instead of this.cwd
          actorJid,
          mcpSocketPath: socketPath,
          onEvent: (event) => this.handleEventPerChat(session, event, toolScopeKey),
          onCrash: (info) => this.handlePerChatCrash(workspaceKey, chatJid, info, session),
          notifyUser: (msg) => {
            this.handleCrashNotify(msg, chatJid);
          },
          onResumeFailed: () => this.handleResumeFailed(chatJid),
          eventToolScopeKey: toolScopeKey,
        });
        const resumable = getResumableSessionForChat(
          this.db,
          workspaceKey,
          session.getProviderId(),
        );
        log.info({ chatJid, workspaceKey, workspacePath }, 'created sandbox per-chat session manager');
        this.setOwnedPerChatSession(workspaceKey, session);
        const chatQ = this.createOutboundQueue(chatJid, 'sandbox per-chat session init');
        this.chatQueues.set(workspaceKey, chatQ);

        // Wire operation tracker for this sandbox session
        const tracker = this.createOperationTracker(session, () => this.chatQueues.get(workspaceKey));
        if (tracker) this.operationTrackers.set(workspaceKey, tracker);

        // Spawn with resume if available — fall back to fresh session if resume fails
        if (resumable) {
          const resumeOwnership = this.captureOwnedPerChatGeneration(workspaceKey, session);
          try {
            await session.spawnSession(resumable.session_id, resumable.id);
          } catch (err) {
            log.warn({ err, workspaceKey, sessionId: resumable.session_id }, 'resume threw — spawning fresh session');
            try {
              await session.spawnSession();
            } catch (spawnErr) {
              log.error({ err: spawnErr, workspaceKey }, 'fresh spawn also failed — cleaning up workspace');
              throw spawnErr;
            }
          }
          await this.activateSpawnedOwnedPerChatSession(workspaceKey, session, resumeOwnership);
        }
      } catch (err) {
        this.cleanupFailedSandboxWorkspace(workspaceKey);
        throw err;
      }
    }

    // Update delivery JID on existing queue (handles JID variant changes)
    this.chatQueues.get(workspaceKey)?.updateDeliveryJid(chatJid);

    // Update delivery JID on the chat-scoped socket server and media bridge
    const res = this.workspaceResources.get(workspaceKey);
    if (res?.socketServer) {
      res.socketServer.updateDeliveryJid(chatJid);
    }
    if (res?.mediaBridge) {
      setMediaBridgeChat(res.mediaBridge, chatJid);
    }
    if (res) {
      res.lastActivity = Date.now();
    }

    // sandboxPerChat: do NOT set this.session/this.queue shared fields.
    // All per_chat code paths look up from chatSessions/chatQueues maps directly.
  }

  /**
   * Synchronous session/queue initialization for non-sandboxPerChat mode.
   * Kept synchronous to preserve microtask ordering in existing code paths.
   */
  private ensureSessionAndQueueSync(
    chatJid: string,
    initialMapKey: string = this.resolvePerChatMapKey(chatJid),
    actorJid?: string,
  ): void {
    // Task G (D14): consume a deferred route recycle BEFORE the "does a
    // session already exist" checks below — every inbound message reaches
    // this point ahead of any turn dispatch, so this is the turn-idle
    // boundary a busy-time pin deferred to. Detaching here (only when truly
    // idle) makes the per_chat/single checks below see no session and
    // respawn fresh via createSessionManager, which re-resolves the route.
    if (this.sessionScope === 'per_chat') {
      // per_chat: independent session + queue per canonical chat key
      if (!this.chatSessions.has(initialMapKey)) {
        const toolScopeKey = this.createToolScopeKey(initialMapKey);
        let session!: SessionManager;
        const resolveSessionMapKey = () => this.findMapKeyForSession(session, initialMapKey);
        // F-STICKY-ACTOR (QR-247 hardening): the per-chat actor socket is now wired
        // INSIDE createSessionManager (keyed on the session's actual provider), so the
        // proactive-resume + provider-fallback spawn paths bind identically. See
        // wirePerChatActorSocket + the choke-point guard.
        session = this.createSessionManager({
          chatJid,
          cwd: this.cwd,
          actorJid,
          onEvent: (event) => this.handleEventPerChat(session, event, toolScopeKey),
          onCrash: (info) => {
            const mapKey = resolveSessionMapKey() ?? initialMapKey;
            this.handlePerChatCrash(mapKey, chatJid, info, session);
          },
          notifyUser: (msg) => {
            this.handleCrashNotify(msg, chatJid);
          },
          eventToolScopeKey: toolScopeKey,
        });
        log.info({ chatJid, mapKey: initialMapKey, sessionScope: this.sessionScope }, 'created per-chat session manager');
        this.setOwnedPerChatSession(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'per-chat session init');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this per-chat session
        const tracker = this.createOperationTracker(session, () => {
          const currentMapKey = resolveSessionMapKey();
          return currentMapKey ? this.chatQueues.get(currentMapKey) : undefined;
        });
        if (tracker) this.operationTrackers.set(initialMapKey, tracker);
      }
      this.chatQueues.get(initialMapKey)?.updateDeliveryJid(chatJid);
      // per_chat mode: do NOT set this.session/this.queue shared fields.
      // /status, /new, and crash handlers look up from chatSessions/chatQueues maps directly.
      return;
    }

    // single/shared: singleton session
    if (!this.session) {
      this.activeChatJid = chatJid;
      let singletonSession!: SessionManager;
      singletonSession = this.createSessionManager({
        chatJid,
        cwd: this.cwd,
        actorJid,
        trackSingletonMcpSession: true,
        onEvent: (event) => this.handleEvent(singletonSession, event),
        onCrash: (info) => {
          this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
          const turnWasInFlight = this.currentRuntimeTurnContext !== null;
          const queue = this.getActiveQueue();
          this.finalizeRuntimeCrash(this.currentRuntimeTurnContext, queue, this.session);
          this.cleanupSharedCrashTurnState();
          this.emitCrashHealReport(chatJid, info, turnWasInFlight);
        },
        notifyUser: (msg) => this.handleCrashNotify(msg),
      });
      this.session = singletonSession;
      log.info({ chatJid, shared: this.shared, sessionScope: this.sessionScope }, 'created shared/single session manager');
      if (this.shared) {
        this.ensureOutboundQueue(chatJid);
      } else {
        const singletonQ = this.createOutboundQueue(chatJid, 'single session init');
        this.queue = singletonQ;
      }

      // Wire operation tracker for single/shared session
      this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());
    } else if (this.shared) {
      this.ensureOutboundQueue(chatJid);
    }
  }

  /**
   * Ensure a per-chat outbound queue exists for the given JID (shared mode).
   * @check CHK-066 // @traces REQ-012.AC-05
   */
  private ensureOutboundQueue(chatJid: string): void {
    if (!this.outboundQueues.has(chatJid)) {
      const q = this.createOutboundQueue(chatJid, 'shared ensureOutboundQueue');
      this.outboundQueues.set(chatJid, q);
    }
  }

  /**
   * Report a provider crash to the heal pipeline.
   *
   * #1754: a crash must ALWAYS attempt to report — even with zero control peers configured,
   * emitHealReport's own BOT ERRORS fallback (heal.ts) is the guaranteed-or-alerted delivery
   * path, so this is never gated on `config.controlPeers.size > 0`.
   *
   * The one exception is the supervisor's own idle reap with no turn in flight: the 30-min
   * inactivity kill is routine housekeeping on a healthy session, and paging an operator to
   * "investigate and remediate" a SIGKILL we issued on purpose is noise, not a fault. A reap
   * that interrupts an in-flight turn IS a fault (the provider stalled), so it still reports.
   */
  private emitCrashHealReport(
    chatJid: string,
    info: SessionCrashInfo,
    turnWasInFlight: boolean,
  ): void {
    if (info.terminationReason === 'idle_watchdog' && !turnWasInFlight) {
      log.info({ chatJid, signal: info.signal ?? null, terminationReason: info.terminationReason }, 'idle-watchdog reap on an idle session — no heal report');
      return;
    }
    try {
      const crashClass = allowlistedHealCrashClass(info.crashClass);
      emitHealReport(this.db, this.messenger, this.durability, {
        type: 'crash',
        ...(crashClass ? { crashClass } : {}),
        ...(info.exitCode !== null || info.signal ? { termination: 'exit_or_signal' as const } : {}),
      }, this.activeControlReportId);
    } catch (err) {
      log.warn({ err }, 'failed to emit heal report for session crash');
    }
  }

  private handlePerChatCrash(
    mapKey: string,
    chatJid?: string,
    info?: SessionCrashInfo,
    expectedSession?: SessionManager,
  ): void {
    const session = expectedSession ?? this.chatSessions.get(mapKey);
    const currentMapKey = this.findMapKeyForSession(session, mapKey);
    if (!session || !currentMapKey || this.chatSessions.get(currentMapKey) !== session) {
      log.debug({ mapKey, chatJid }, 'crash callback dropped — manager is no longer mapped');
      return;
    }
    const managerId = this.sessionManagerIds.get(session);
    const owner = this.sessionOwnership.get(currentMapKey);
    const generationIdentity = info?.generationIdentity;
    if (
      !managerId ||
      !owner ||
      owner.managerId !== managerId ||
      !this.sessionOwnership.isCurrent(currentMapKey, managerId, owner.generation) ||
      !generationIdentity ||
      generationIdentity.managerId !== managerId ||
      generationIdentity.generation !== owner.generation
    ) {
      log.debug({
        mapKey: currentMapKey,
        chatJid,
        expectedManagerId: managerId ?? null,
        expectedGeneration: owner?.generation ?? null,
        callbackManagerId: generationIdentity?.managerId ?? null,
        callbackGeneration: generationIdentity?.generation ?? null,
      }, 'crash callback dropped — manager generation is not current');
      return;
    }
    if (
      owner.state === 'recoverable_dead' ||
      owner.state === 'exhausted' ||
      owner.state === 'closing' ||
      owner.state === 'resetting'
    ) {
      log.debug({ mapKey: currentMapKey, state: owner.state }, 'duplicate or terminal crash callback dropped');
      return;
    }

    const recoveryGeneration = owner.generation;
    const journaledCrashSeq = this.perChatInboundSeqQueue.get(currentMapKey)?.[0];
    const publishedCrashContexts = this.perChatRuntimeTurnContexts.get(currentMapKey) ?? [];
    const publishedCrashContext = publishedCrashContexts.length === 1
      ? publishedCrashContexts[0]
      : undefined;
    const activeTurnQueue = this.perChatTurnQueues.get(currentMapKey);
    const activeTurn = activeTurnQueue?.activeTurn;
    const activeTurnContext = activeTurn?.runtimeContext;
    const undispatchedCrashContext = publishedCrashContexts.length === 0
      && activeTurnContext?.identity.scope === 'per_chat'
      && activeTurn?.inboundSeq !== undefined
      && activeTurnContext.identity.inboundSeq === activeTurn.inboundSeq
      && journaledCrashSeq === activeTurn.inboundSeq
      ? activeTurnContext
      : undefined;
    const crashContext = publishedCrashContext ?? undispatchedCrashContext;
    const crashQueue = this.chatQueues.get(currentMapKey);
    if (publishedCrashContexts.length > 1) {
      log.error(
        { mapKey: currentMapKey, contextCount: publishedCrashContexts.length },
        'per-chat crash has multiple published turn owners; retaining the FIFO fail-closed',
      );
    }

    this.sessionOwnership.transition(currentMapKey, managerId, 'recoverable_dead');
    this.recordCrash(currentMapKey);
    const crashCount = this.getCrashCount(currentMapKey);
    const exhausted = crashCount > AUTO_RESPAWN_MAX_CRASHES;
    if (exhausted) {
      this.terminalizeExhaustedPerChatSession(
        currentMapKey,
        session,
        managerId,
        recoveryGeneration,
        crashContext,
      );
    }
    if (undispatchedCrashContext) {
      const scopeRef = activeTurnQueue
        ? this.perChatTurnQueueKeys.get(activeTurnQueue) ?? { value: currentMapKey }
        : { value: currentMapKey };
      this.runtimeTurnCoordinator.terminalizeUndispatchedRuntimeCrash(
        undispatchedCrashContext,
        scopeRef,
      );
    } else if (!crashContext && journaledCrashSeq !== undefined) {
      crashQueue?.abortTurn({ preserveEvidence: true });
      log.error(
        { mapKey: currentMapKey, inboundSeq: journaledCrashSeq },
        'journaled per-chat crash has no provable immutable context; retaining exhausted ownership',
      );
    } else {
      this.finalizeRuntimeCrash(crashContext, crashQueue, session, currentMapKey);
    }
    const tracker = this.operationTrackers.get(currentMapKey);
    tracker?.shutdown();
    this.operationTrackers.delete(currentMapKey);
    this.cleanupPerChatCrashTurnState(currentMapKey);
    if (chatJid && info) {
      this.emitCrashHealReport(
        chatJid,
        info,
        crashContext !== undefined || journaledCrashSeq !== undefined,
      );
    }

    // Auto-respawn: if we haven't hit the crash limit, try to resume the session
    // after a short delay. This lets the agent continue mid-conversation without
    // requiring the user to send a new message.
    if (crashCount <= AUTO_RESPAWN_MAX_CRASHES && info?.sessionId) {
      const sessionId = info.sessionId;
      const dbRowId = info.dbRowId;
      const crashedAtSec = Math.floor(Date.now() / 1000);
      const delayMs = jitteredDelay(AUTO_RESPAWN_BASE_MS, crashCount - 1, AUTO_RESPAWN_MAX_DELAY_MS);
      log.info({ mapKey: currentMapKey, sessionId, attempt: crashCount, delayMs }, 'scheduling auto-respawn');
      const timer = setTimeout(() => {
        void this.runOwnedPerChatRespawn({
          initialMapKey: currentMapKey,
          chatJid,
          session,
          managerId,
          recoveryGeneration,
          sessionId,
          dbRowId,
          crashedAtSec,
          timer,
        });
      }, delayMs);
      if (this.sessionOwnership.setRespawnTimer(currentMapKey, managerId, recoveryGeneration, timer)) {
        this.pendingRespawnTimers.add(timer);
      } else {
        clearTimeout(timer);
      }
    } else if (exhausted) {
      log.error({ mapKey: currentMapKey, crashes: crashCount }, 'auto-respawn exhausted — emitting alert');
      emitAlertChecked(
        this.instanceName,
        'agent_respawn_failed',
        `whatsoup@${this.instanceName} agent respawn exhausted (${crashCount} crashes)`,
        [
          `Chat: ${currentMapKey}`,
          `Last exit: code=${info?.exitCode ?? '?'} signal=${info?.signal ?? 'none'}`,
          `Provider: ${info?.provider ?? 'unknown'}`,
          `Crash class: ${info?.crashClass ?? 'unknown'}`,
          info?.stderrPreview ? `Stderr preview: ${info.stderrPreview.slice(-500)}` : null,
        ].filter(Boolean).join('\n'),
      );
    }
  }

  private async runOwnedPerChatRespawn(args: {
    initialMapKey: string;
    chatJid?: string;
    session: SessionManager;
    managerId: string;
    recoveryGeneration: number;
    sessionId: string;
    dbRowId: number | null;
    crashedAtSec: number;
    timer: ReturnType<typeof setTimeout>;
  }): Promise<void> {
    this.pendingRespawnTimers.delete(args.timer);
    const mapKey = this.findMapKeyForSession(args.session, args.initialMapKey);
    if (!mapKey) return;
    if (
      !this.sessionOwnership.clearRespawnTimer(
        mapKey,
        args.managerId,
        args.recoveryGeneration,
        args.timer,
      )
    ) {
      const current = this.sessionOwnership.get(mapKey);
      if (current?.managerId === args.managerId && current.respawnTimer === args.timer) {
        this.sessionOwnership.clearRespawnTimer(
          mapKey,
          args.managerId,
          current.generation,
          args.timer,
        );
      }
      return;
    }

    const owner = this.sessionOwnership.get(mapKey);
    const status = args.session.getStatus();
    if (
      this.chatSessions.get(mapKey) !== args.session ||
      owner?.managerId !== args.managerId ||
      owner.generation !== args.recoveryGeneration ||
      owner.state !== 'recoverable_dead' ||
      status.active ||
      status.pid !== null
    ) {
      return;
    }

    this.sessionOwnership.transition(mapKey, args.managerId, 'respawning');
    const respawnGeneration = this.sessionOwnership.advanceGeneration(mapKey, args.managerId);
    log.info({ mapKey, sessionId: args.sessionId, generation: respawnGeneration }, 'auto-respawn: attempting resume');

    try {
      await args.session.spawnSession(args.sessionId, args.dbRowId ?? undefined);
      const activeMapKey = await this.activateSpawnedOwnedPerChatSession(
        mapKey,
        args.session,
        { managerId: args.managerId, generation: respawnGeneration },
      );
      const tracker = this.createOperationTracker(
        args.session,
        () => {
          const currentMapKey = this.findMapKeyForSession(args.session, activeMapKey);
          return currentMapKey ? this.chatQueues.get(currentMapKey) : undefined;
        },
      );
      if (tracker) this.operationTrackers.set(activeMapKey, tracker);

      await sleep(1_000);
      if (
        this.chatSessions.get(activeMapKey) !== args.session ||
        !this.sessionOwnership.isCurrent(activeMapKey, args.managerId, respawnGeneration) ||
        this.sessionOwnership.get(activeMapKey)?.state !== 'active' ||
        !args.session.getStatus().active
      ) {
        return;
      }
      let respawnRecoveryPublished = false;
      const publishRespawnRecovery = (): void => {
        if (respawnRecoveryPublished) return;
        respawnRecoveryPublished = true;
        clearAlertSourceChecked(this.instanceName, 'agent_respawn_failed');
      };
      let contextLease: SystemTurnLeaseToken | null = null;
      let continuationLease: SystemTurnLeaseToken | null = null;
      try {
        if (args.chatJid) {
          contextLease = this.markSystemTurn(
            args.session,
            activeMapKey,
            'respawn_context',
            args.chatJid,
          );
          const injected = await this.injectMissedMessages(
            args.session,
            args.chatJid,
            args.crashedAtSec,
            () => {
              this.requireSystemTurnProviderBoundary(contextLease!);
            },
          );
          if (!injected) this.pendingSystemResults.cancel(contextLease);
          else {
            await this.pendingSystemResults.waitUntilEmpty(activeMapKey);
            await this.waitForSystemTurnQuarantine(activeMapKey);
            if (!args.session.getStatus().active) return;
          }
        }
        continuationLease = this.markSystemTurn(
          args.session,
          activeMapKey,
          'respawn_continuation',
          args.chatJid,
        );
        await this.dispatchSystemTurn(
          args.session, '[System: session resumed after crash ��� continue where you left off]',
          continuationLease!, publishRespawnRecovery,
        );
        log.info({ mapKey: activeMapKey }, 'sent continuation turn after auto-respawn');
      } catch (err) {
        log.warn({ err, mapKey: activeMapKey }, 'failed to send continuation turn after auto-respawn');
        await this.settleFailedSystemTurnDispatch(
          args.session,
          activeMapKey,
          continuationLease ?? contextLease,
          err,
        );
      }
    } catch (err) {
      const currentMapKey = this.findMapKeyForSession(args.session, mapKey);
      if (
        currentMapKey &&
        this.sessionOwnership.isCurrent(currentMapKey, args.managerId, respawnGeneration)
      ) {
        const failedStatus = args.session.getStatus();
        this.sessionOwnership.transition(
          currentMapKey,
          args.managerId,
          !failedStatus.active && failedStatus.pid === null ? 'recoverable_dead' : 'closing',
        );
      }
      log.warn({ err, mapKey, sessionId: args.sessionId }, 'auto-respawn resume failed — will retry on next message');
    }
  }

  private terminalizeExhaustedPerChatSession(
    mapKey: string,
    session: SessionManager,
    managerId: string,
    generation: number,
    crashContext?: RuntimeTurnContext,
  ): void {
    if (
      this.chatSessions.get(mapKey) !== session ||
      !this.sessionOwnership.isCurrent(mapKey, managerId, generation)
    ) {
      return;
    }
    const owner = this.sessionOwnership.get(mapKey);
    if (!owner) return;
    this.clearOwnedRespawnTimer(mapKey, owner);
    this.sessionOwnership.transition(mapKey, managerId, 'exhausted');
    const journaledInboundSeq = this.perChatInboundSeqQueue.get(mapKey)?.[0];
    if (!crashContext && journaledInboundSeq !== undefined) {
      log.error(
        { mapKey, inboundSeq: journaledInboundSeq },
        'exhausted per-chat session retained because its journaled turn has no immutable context',
      );
      return;
    }
    const release = (): void => {
      const releaseKey = this.findMapKeyForSession(session, mapKey);
      if (
        !releaseKey ||
        this.chatSessions.get(releaseKey) !== session ||
        !this.sessionOwnership.isCurrent(releaseKey, managerId, generation)
      ) {
        return;
      }
      this.chatQueues.get(releaseKey)?.abortTurn();
      this.chatQueues.delete(releaseKey);
      this.cleanupPerChatState(releaseKey, { preserveCrashHistory: true });
      this.chatSessions.delete(releaseKey);
      this.ownedSessionManagers.delete(managerId);
      this.sessionOwnership.release(releaseKey, managerId);
    };
    if (crashContext) {
      this.runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(
        crashContext,
        release,
      );
      return;
    }
    release();
  }

  private cleanupSharedCrashTurnState(): void {
    this.pendingSystemResults.clearScope(GLOBAL_TOOL_SCOPE_KEY);
    this.legacyProviderTurnOwners.delete(GLOBAL_TOOL_SCOPE_KEY);
    this.activeToolNames.clear();
    this.turnHadToolActivity.clear();
    this.singleTurnHadToolActivity = false;
    this.turnHadVisibleOutput = false;
    this.turnHadSuppressedReplySatisfaction = false;
    this.currentTurnChatJid = null;
    this.currentTurnReplayText = null;
    this.currentTurnReplayActorJid = undefined;
    this.currentTurnInboundContentType = null;
    this.currentTurnSourceMessageId = null;
    this.currentTurnAssistantText = '';
    this.currentTurnAssistantItemText.clear();
    // Shutdown operation tracker on crash (timers must be cleared)
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    // If a compact_boundary was already observed before the crash, the SDK
    // produced a fresh compacted context — persist the baseline before
    // dropping the flag, so the next turn doesn't immediately re-fire
    // /compact against a stale lastCompactInputTokens.
    this.persistBaselineIfBoundaryObserved(GLOBAL_TOOL_SCOPE_KEY, this.session?.getDbRowId() ?? null);
    this.consumeCompactBoundary(GLOBAL_TOOL_SCOPE_KEY);
    this.finishAutoCompact(GLOBAL_TOOL_SCOPE_KEY);
    this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
  }

  private cleanupPerChatCrashTurnState(mapKey: string): void {
    this.pendingSystemResults.clearScope(mapKey);
    this.legacyProviderTurnOwners.delete(mapKey);
    // F-STICKY-ACTOR (QR-247, S-CRASH): a crash discards ALL of the subprocess's
    // in-flight turns (executing + buffered), so clear the WHOLE executing-actor
    // queue — NOT shift-one. This runs synchronously in handlePerChatCrash BEFORE
    // the auto-respawn setTimeout, so the direct-sendTurn continuation hits an empty
    // queue -> fail-closed deny, and a later user turn cannot append behind a stale
    // (possibly admin) head and be served that actor = escalation.
    this.perChatExecActorQueue.delete(mapKey);
    this.clearToolScopeFor(mapKey);
    this.singleTurnHadToolActivity = false;
    this.turnHadVisibleOutput = false;
    this.currentTurnChatJid = null;
    this.perChatTurnSourceMessageId.delete(mapKey);
    this.perChatTurnContentType.delete(mapKey);
    this.perChatTurnText.delete(mapKey);
    this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
    this.perChatAssistantItemText.delete(mapKey);
    // Persist baseline first if compact_boundary was observed — see
    // cleanupSharedCrashTurnState for rationale.
    this.persistBaselineIfBoundaryObserved(mapKey, this.chatSessions.get(mapKey)?.getDbRowId() ?? null);
    this.consumeCompactBoundary(mapKey);
    this.finishAutoCompact(mapKey);
    this.clearSilentCompact(mapKey);
  }

  /**
   * On crash cleanup, if compact_boundary was already observed for `scopeKey`
   * (the SDK emitted boundary but the `result` event never landed), persist
   * the baseline now. Otherwise the next turn re-fires /compact against a
   * stale lastCompactInputTokens — one redundant compact per
   * crash-during-compact.
   */
  private persistBaselineIfBoundaryObserved(scopeKey: string, rowId: number | null): void {
    if (rowId === null) return;
    if (!this.autoCompact.compactBoundaryScopes.has(scopeKey)) return;
    markSessionCompacted(this.db, rowId);
    this.recordAutoCompactSuccess(scopeKey);
    log.info({ scopeKey, rowId }, 'auto compact baseline persisted on crash cleanup (compact_boundary observed pre-crash)');
  }

  /**
   * Routes a crash notification through the outbound queue so it arrives after
   * any partial turn output that was already enqueued before the crash.
   * Falls back to a direct send if the queue is gone.
   */
  private handleCrashNotify(msg: string, chatJid?: string): void {
    // In per_chat mode, chatJid MUST be passed — this.queue is not set.
    // In single/shared mode, chatJid is optional (falls back to shared fields).
    const queue = chatJid ? this.getQueueForChat(chatJid) : this.queue;
    if (queue) {
      queue.enqueueText(msg);
      queue.flush().catch((err) => log.error({ err }, 'flush after crash failed'));
    } else {
      const target = chatJid ?? this.activeChatJid;
      if (target) {
        this.messenger
          .sendMessage(target, msg)
          .catch((err) => log.error({ err }, 'crash notice fallback send failed'));
      }
    }
  }

  private formatContextLines(
    messages: ReadonlyArray<{ timestamp: number; senderName: string | null; senderJid: string; content: string | null }>,
  ): string {
    return formatContextLines(messages, this.isFallbackWindowActive);
  }

  /**
   * Inject messages the agent missed during downtime into a resumed session.
   * Uses `sinceUnixSec` (typically the checkpoint's updated_at) to fetch only
   * messages that arrived after the session was last active.
   * Returns true if any context was injected.
   */
  private async injectMissedMessages(
    session: SessionManager,
    chatJid: string,
    sinceUnixSec: number,
    onProviderBoundaryReady: () => void = () => {},
  ): Promise<boolean> {
    let lines: string;
    let messageCount: number;
    try {
      const convKey = canonicalConversationKey(chatJid, this.db);
      const missed = getMessagesSince(this.db, convKey, sinceUnixSec, 30);
      if (missed.length === 0) return false;
      lines = this.formatContextLines(missed);
      messageCount = missed.length;
    } catch (err) {
      log.warn({ err, chatJid }, 'missed message lookup failed — agent continues without context');
      return false;
    }
    // Dispatch errors propagate so the caller can distinguish a proven
    // pre-dispatch failure from an ambiguous accepted write and quarantine the
    // provider generation before releasing this system lease.
    await dispatchProviderTurn(
      session,
      `[Recent chat context — read before responding]\n${lines}`,
      onProviderBoundaryReady,
    );
    log.info({ chatJid, messageCount, sinceUnixSec }, 'injected missed messages after resume');
    return true;
  }

  /**
   * Called by SessionManager when a --resume attempt is rejected by Claude
   * (exit code 1, no init event). Sends a clear status message and spawns a
   * fresh session so the user can continue without manual intervention.
   */
  private handleResumeFailed(chatJid: string): void {
    log.warn({ chatJid }, 'resume failed — spawning fresh session');

    // Resolve the correct session and mapKey — sandboxPerChat uses the per-chat map,
    // single/shared mode uses the shared this.session field.
    let session: SessionManager | undefined;
    let mapKey: string | undefined;
    if (this.sandboxPerChat) {
      const ws = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
      mapKey = ws.workspaceKey;
      session = this.chatSessions.get(mapKey);
    } else {
      session = this.session ?? undefined;
    }
    if (mapKey) this.abortImageCoalesceBuffer(mapKey, 'resume_failed');
    if (!session) {
      log.warn({ chatJid }, 'handleResumeFailed: no session — skipping');
      return;
    }

    // Pending-turn replay only applies to sandboxPerChat (per_chat) mode.
    // sendTurnPerChat sets pendingTurnText[mapKey] before calling sendTurnToSession,
    // so if a resume fails mid-send the turn text is available for replay.
    // single/shared mode uses sendTurnNonShared → sendTurnToSession directly and never
    // populates pendingTurnText, so mapKey is undefined here and pendingText will
    // always be undefined — which is correct, as no turn is in-flight at resume time.
    const pendingText = mapKey ? this.pendingTurnText.get(mapKey) : undefined;

    if (!pendingText) {
      // No pending message — notify user to resend
      const msg = '_Previous session expired_ — starting fresh. Send a message to begin.';
      if (this.pendingStartupEvent !== null) {
        this.pendingStartupEvent = { kind: 'expired_session_notice', chatJid, text: msg };
      } else {
        this.sendDirect(chatJid, msg);
      }
    }

    // Mark this mapKey as owned by handleResumeFailed before spawning
    // so that any concurrent sendTurnToSession call for the same chat skips its own
    // context injection (preventing double context blocks on the fresh session).
    if (mapKey) this.resumeFailedHandling.add(mapKey);

    // Spawn a clean session and replay the pending turn if one exists.
    // The `pendingText && mapKey` guard below is a no-op for single/shared mode
    // (mapKey is always undefined) — replay is sandboxPerChat-only by design.
    const resumeOwnership = mapKey
      ? this.captureOwnedPerChatGeneration(mapKey, session)
      : null;
    session
      .spawnSession()
      .then(async () => {
        if (mapKey && resumeOwnership) {
          mapKey = await this.activateSpawnedOwnedPerChatSession(mapKey, session, resumeOwnership);
        }

        // context injection + replay wrapped in turnChain to preserve serialization
        this.turnChain = this.turnChain.then(async () => {
          // Clear the resumeFailedHandling flag once we are inside the chain —
          // the context injection below is about to run, after which concurrent
          // sendTurnToSession calls may inject normally.
          if (mapKey) this.resumeFailedHandling.delete(mapKey);

          let contextLease: SystemTurnLeaseToken | null = null;
          try {
            const recent = getRecentMessages(this.db, canonicalConversationKey(chatJid, this.db), 30);
            if (recent.length > 0) {
              const lines = this.formatContextLines(recent.reverse());
              // QR-095: same fix as the sendTurnToSession injection — in single/
              // shared mode mapKey is undefined here, so mark under GLOBAL to match
              // the single/shared consumeIfPending(GLOBAL_TOOL_SCOPE_KEY); otherwise
              // the '[CONTEXT RECOVERY]' system turn's result leaks to the user.
              // No-op in per_chat (mapKey defined, consumed per-chat).
              contextLease = this.markSystemTurn(
                session,
                mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
                'resume_failure_context',
                chatJid,
              );
              await this.dispatchSystemTurn(
                session, `[CONTEXT RECOVERY — prior session expired]\n${lines}`, contextLease!,
              );
              await this.pendingSystemResults.waitUntilEmpty(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
              await this.waitForSystemTurnQuarantine(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
              if (!session.getStatus().active) return;
            }
          } catch (err) {
            log.warn({ err, chatJid }, 'context recovery failed — starting blank session');
            await this.settleFailedSystemTurnDispatch(
              session,
              mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
              contextLease,
              err,
            );
          }
          // Replay the pending turn that was lost during the failed resume
          if (pendingText && mapKey) {
            log.info({ chatJid, mapKey, textPreview: providerPreview(pendingText, 80) }, 'replaying pending turn after resume failure');
            try {
              await session.sendTurn(renderPendingReplay(this.turnChronology, pendingText,
                this.perChatRuntimeTurnContexts.get(mapKey)?.[0], this.perChatTurnQueues.get(mapKey)?.activeTurn ?? null));
            } catch (err) {
              log.warn({ err, chatJid }, 'pending turn replay failed');
              // Retain the replay evidence. A failed or ambiguously accepted
              // write must never silently discard the user's original turn.
            }
          }
        }).catch((err) => {
          log.error({ err, chatJid, mapKey }, 'context recovery turn failed after resume failure');
        });
      })
      .catch((err) => {
        if (mapKey) this.resumeFailedHandling.delete(mapKey);
        log.error({ err }, 'failed to spawn fresh session after resume failure');
      });
  }

  /**
   * Synthesize the agent's text response via ElevenLabs and send as a PTT voice note.
   * Non-fatal — called after the text response has already been delivered. (SP4)
   */
  private async _sendVoiceReply(chatJid: string, responseText: string): Promise<void> {
    try {
      const voiceResult = await synthesizeSpeech(responseText, {
        voiceId: config.elevenlabs.defaultVoiceId,
        modelId: config.elevenlabs.defaultModel,
        stability: config.elevenlabs.stability,
        similarityBoost: config.elevenlabs.similarityBoost,
      });

      const voicePath = writeTempFile(voiceResult.buffer, 'mp3');
      const { readFileSync } = await import('node:fs');
      const voiceBuffer = readFileSync(voicePath);

      await (this.messenger as ConnectionManager).sendMedia(chatJid, {
        type: 'audio',
        buffer: voiceBuffer,
        mimetype: 'audio/mpeg',
        ptt: true,
        seconds: voiceResult.duration,
      });

      log.info({ chatJid, duration: voiceResult.duration }, 'voice reply sent');
    } catch (err) {
      // Non-fatal: text response was already sent. Log and continue.
      log.warn({ err, chatJid }, 'voice reply failed — text response already sent');
    }
  }

  private handleEvent(sourceSession: SessionManager, event: AgentEvent): void {
    if (
      sourceSession !== this.session
      || this.sessionEventToolScopes.get(sourceSession) !== GLOBAL_TOOL_SCOPE_KEY
    ) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        'none',
        'source_session_not_current',
        sourceSession,
      );
      return;
    }
    const managerId = this.sessionManagerIds.get(sourceSession);
    if (!managerId) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        'none',
        'source_generation_not_current',
        sourceSession,
      );
      return;
    }
    const runtimeContext = this.runtimeTurnCoordinator.runtimeTurnContext();
    const runtimeOwnerMatches = runtimeContext !== null
      && runtimeContext.identity.managerId === managerId
      && runtimeContext.identity.generation === 1
      && runtimeContext.toolScopeKey === GLOBAL_TOOL_SCOPE_KEY;
    const legacyOwner = this.legacyProviderTurnMatches(
      GLOBAL_TOOL_SCOPE_KEY,
      managerId,
      1,
      GLOBAL_TOOL_SCOPE_KEY,
    );
    const logicalOwnerMatches = runtimeOwnerMatches || legacyOwner !== null;
    const systemTurn = this.pendingSystemResults.peek(GLOBAL_TOOL_SCOPE_KEY);
    const systemOwnerMatches = systemTurn?.owner != null
      && systemTurn.owner.managerId === managerId
      && systemTurn.owner.generation === 1
      && systemTurn.owner.toolScopeKey === GLOBAL_TOOL_SCOPE_KEY;
    const resolved = this.resolveProviderEventOwner(
      event,
      logicalOwnerMatches,
      systemOwnerMatches ? systemTurn : null,
    );
    const decision = decideProviderEventAdmission(event, resolved.owner);
    if (!decision.admit) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        resolved.owner.kind,
        decision.reason,
        sourceSession,
      );
      return;
    }
    if (event.type === 'ignored') return;

    const routeChatJid = resolved.owner.kind === 'logical_turn'
      ? (runtimeOwnerMatches
          ? runtimeContext!.identity.deliveryJid
          : legacyOwner?.routeChatJid)
      : resolved.systemTurn?.routeChatJid;
    let queue = this.shared
      ? (routeChatJid
          ? this.outboundQueues.get(routeChatJid)
            ?? this.outboundQueues.get(canonicalizeChatJid(routeChatJid, this.db))
            ?? null
          : null)
      : this.queue;
    if (!queue && event.type === 'result' && routeChatJid) {
      queue = this.createOutboundQueue(routeChatJid, 'provider terminal route recovery');
      if (this.shared) this.outboundQueues.set(routeChatJid, queue);
      else this.queue = queue;
      log.warn(
        { routeChatJid, ownerKind: resolved.owner.kind, shared: this.shared },
        'reconstructed missing output route for an owned provider terminal',
      );
    }
    const resultNeedsRoute = event.type === 'result'
      && (
        resolved.owner.kind === 'logical_turn'
        || (resolved.systemTurn !== null && systemPurposeAllowsOutput(resolved.systemTurn.purpose))
      );
    if (resultNeedsRoute && !queue) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        resolved.owner.kind,
        'owner_queue_missing',
        sourceSession,
      );
      return;
    }

    if (
      event.type === 'result'
      && resolved.owner.kind === 'logical_turn'
      && legacyOwner !== null
    ) {
      this.clearLegacyProviderTurn(GLOBAL_TOOL_SCOPE_KEY, legacyOwner);
    }

    let consumedSystemTurn: PendingSystemTurnSnapshot | null = null;
    if (event.type === 'result' && resolved.systemTurn) {
      consumedSystemTurn = this.pendingSystemResults.consumeResult(resolved.systemTurn.lease);
      if (!consumedSystemTurn) {
        this.rejectProviderEvent(
          event.type,
          'singleton_shared',
          'system_request',
          'system_owner_race',
          sourceSession,
        );
        return;
      }
      this.releaseSystemTurnExecutingActor(consumedSystemTurn);
      if (!systemPurposeAllowsOutput(consumedSystemTurn.purpose)) {
        this.handleRestrictedSystemResult(
          sourceSession,
          GLOBAL_TOOL_SCOPE_KEY,
          consumedSystemTurn,
          event,
          this.operationTracker,
        );
        return;
      }
    }

    if (!queue) {
      if (event.type === 'init') {
        log.debug('session init observed without an active output route');
        return;
      }
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        resolved.owner.kind,
        'owner_queue_missing',
        sourceSession,
      );
      return;
    }

    const tracker = this.operationTracker;

    switch (event.type) {
      case 'init':
        log.debug({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        this.session?.tickWatchdog();
        tracker?.onAnyActivity();
        // Post-turn gate: suppress phantom assistant_text (same as handleEventWithContext)
        if (this.postTurnGate.has(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ textPreview: providerPreview(event.text, 200) }, 'post-turn gate: suppressed phantom assistant_text (shared)');
          break;
        }
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;

        {
          const rawAssistantText = this.normalizeAssistantTextForDelivery(event);
          if (!rawAssistantText) break;
          // Slice-3 NL routing: consume typed intent markers before delivery
          // (flag off → pass-through, byte-identical). Streaming-safe: the
          // first line is buffered across token deltas so a split marker never
          // leaks (R1).
          let normalizedText: string | null;
          if (config.nlRouting) {
            const step = this.scanRouteMarkerDelta(
              this.currentTurnRouteMarkerHold,
              rawAssistantText,
              (this.shared ? this.currentTurnChatJid : this.activeChatJid) ?? queue.targetChatJid,
              this.currentTurnReplayActorJid,
            );
            this.currentTurnRouteMarkerHold = step.held;
            normalizedText = step.deliver;
          } else {
            normalizedText = rawAssistantText;
          }
          if (!normalizedText) break;
          if (this.enqueueAutoSwitchNotice(queue, normalizedText, this.shared ? this.currentTurnChatJid : this.activeChatJid, 'streaming')) {
            this.turnHadVisibleOutput = true;
            break;
          }
          // Two-tier provider-failure gate (QR-209) — same policy as the per-chat
          // handler. Fallback is armed on the terminal 'result' event, not here.
          // Only BANNER-confident text (the error itself) is suppressed; AMBIENT
          // prose about an error is delivered, so genuine replies are never silently
          // dropped. See suppressStreamedProviderFailure.
          const sharedChatJid = this.shared ? this.currentTurnChatJid : this.activeChatJid;
          const providerFailureCheck = this.suppressStreamedProviderFailure(normalizedText, sharedChatJid);
          if (providerFailureCheck.suppress) break;
          const gatedText = this.gateAssistantTextForOutbound(normalizedText, queue, this.currentInboundSeq);
          this.logAmbientProviderFailureOutcome(providerFailureCheck.ambient, normalizedText, sharedChatJid, gatedText !== null);
          normalizedText = gatedText;
          if (!normalizedText) break;
          queue.enqueueStreamingText(normalizedText);
          this.turnHadVisibleOutput = true;
          if (this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0) {
            this.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe();
          }
          // Reply-guarantee: visible output reached the user — reset the silence
          // window so the "still working" fallback only fires after a full window
          // of TRUE silence, not while a long turn is actively streaming replies.
          this.replyGuarantee?.notifyActivity(queue.targetChatJid);
          // Accumulate text for voice reply (SP4)
          this.currentTurnAssistantText += normalizedText;
        }
        break;

      case 'tool_use':
        this.session?.trackToolStart(event.toolId);
        this.session?.tickWatchdog();
        // Post-turn gate: suppress phantom tool_use (same as handleEventWithContext)
        if (this.postTurnGate.has(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ toolName: event.toolName }, 'post-turn gate: suppressed phantom tool_use (shared)');
          break;
        }
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;

        if (this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0 && this.currentRuntimeTurnContext) {
          this.currentRuntimeTurnContext = markRuntimeTurnReplayUnsafe(this.currentRuntimeTurnContext);
        }

        // AskUserQuestion → Poll bridge is NOT supported in shared mode.
        // Shared mode's turn lifecycle (currentTurnChatJid, turnQueue) makes
        // safe answer injection non-trivial — currentTurnChatJid is cleared
        // after the result event, so the injected answer turn would have no
        // queue context and events would be dropped. Future enhancement.
        // In shared mode, AskUserQuestion falls through to normal tool_use
        // handling — Claude's auto-resolved error is shown to the user.
        if (event.toolName === 'AskUserQuestion') {
          log.info({ toolName: event.toolName }, 'AskUserQuestion poll bridge not supported in shared mode — falling through to normal handling');
        }

        this.getToolNames(GLOBAL_TOOL_SCOPE_KEY).set(event.toolId, event.toolName);
        this.singleTurnHadToolActivity = true;
        {
          const toolUpdate = buildToolUpdate(event.toolName, event.toolInput ?? {});
          queue.enqueueToolUpdate(toolUpdate);
          tracker?.onToolStart(event.toolId, event.toolName, toolUpdate.category);
        }
        break;

      // @check CHK-023
      // @traces REQ-005.AC-05
      case 'compact_boundary':
        this.session?.tickWatchdog();
        tracker?.onAnyActivity();
        this.autoCompact.compactBoundaryScopes.add(GLOBAL_TOOL_SCOPE_KEY);
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid }, 'silent agent compact boundary observed');
          break;
        }
        // Start the composing indicator so the user sees activity during compaction,
        // then send the notification. The indicator stays alive via the heartbeat
        // until the turn's result event fires flush().
        queue.indicateTyping();
        queue.enqueueText(
          'Context compacted — older details summarized. Restate any important context I should carry forward.',
        );
        this.turnHadVisibleOutput = true;
        break;

      case 'tool_result':
        this.session?.trackToolEnd(event.toolId);
        this.session?.tickWatchdog();
        tracker?.onToolEnd(event.toolId);

        // Note: AskUserQuestion poll bridge is per_chat only. In shared mode,
        // tool_result flows normally (no suppression needed — interception is
        // not active). suppressedAskUserToolIds is only populated by per_chat
        // handleEventWithContext.

        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;
        const toolNames = this.activeToolNames.get(GLOBAL_TOOL_SCOPE_KEY);
        const trackedToolName = toolNames?.get(event.toolId);
        const resultToolName = event.toolName?.trim() || undefined;
        if (trackedToolName === undefined) {
          this.singleTurnHadToolActivity = true;
          if (this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0 && this.currentRuntimeTurnContext) {
            this.currentRuntimeTurnContext = markRuntimeTurnReplayUnsafe(this.currentRuntimeTurnContext);
          }
        }
        if (event.isError) {
          const toolName = trackedToolName ?? resultToolName ?? 'unknown';
          const errorPreview = event.content.length > 200 ? `${providerPreview(event.content, 200)}...` : providerPreview(event.content, event.content.length);
          log.warn({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            error: errorPreview,
          }, 'tool error reported by agent');
          const classification = classifyToolError(toolName, event.content);
          queue.enqueueToolUpdate(classification);
          maybeEmitToolFailureAlert({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            content: event.content,
            classification,
            toolScopeKey: GLOBAL_TOOL_SCOPE_KEY,
          }, this.toolFailureAlertDeps());
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(GLOBAL_TOOL_SCOPE_KEY);
        }
        break;

      case 'result':
        handleGlobalRuntimeResult(this.runtimeTurnHost, {
          event,
          queue,
          systemTurnPurpose: consumedSystemTurn?.purpose ?? null,
          tracker: tracker ?? undefined,
          extractUsageLimitResetTime,
        });
        break;
      case 'token_usage':
        // Record token usage without triggering turn completion (non-per-chat path).
        if (
          !this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY) &&
          this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0
        ) {
          this.recordAutoCompactNextTurnIfNeeded(GLOBAL_TOOL_SCOPE_KEY, event.inputTokens, false);
        }
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = this.session?.getDbRowId() ?? null;
          if (rowId !== null) {
            const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
            accumulateTokensWithEvent(this.db, rowId, newInputTokens, event.outputTokens ?? 0, cacheReadTokens);
          }
        }
        break;

      case 'unknown_block':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown_block/unknown/parse_error event');
        break;
    }
  }

}
