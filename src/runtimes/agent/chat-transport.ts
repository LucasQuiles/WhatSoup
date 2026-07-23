/**
 * Per-chat transport resolution — the F-STICKY-ACTOR per-chat MCP socket
 * lifecycle (derive/create/wire/teardown, executing-actor resolution, the
 * actor-race exposure checks) plus the sibling outbound-queue/operation-
 * tracker/session-map-key lookups and the `sendDirect` entry point that
 * consumes them.
 *
 * Extracted from AgentRuntime as a slice of the god-class decomposition, in
 * the same shape as the model-pin port (`createModelPinHost` in
 * runtime.ts): free functions over a narrow `ChatTransportPort` the runtime
 * satisfies with a host object, so AgentRuntime keeps thin delegating
 * privates for the call sites that remain in it and behavior is unchanged.
 */
import { mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createChildLogger } from '../../logger.ts';
import { config } from '../../config.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import type { Messenger } from '../../core/types.ts';
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import { perChatActorSession } from './per-chat-actor-session.ts';
import { writeMcpConfigToPath } from './providers/mcp-bridge.ts';
import type { SessionManager } from './session.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import { OperationTracker, type ProgressEvent } from './operation-tracker.ts';

// Same component name as AgentRuntime: the log lines below keep their
// existing `component: 'agent-runtime'` binding (no observable change).
const log = createChildLogger('agent-runtime');

/** The AgentRuntime surface the per-chat transport helpers read and mutate. Declared here rather than importing AgentRuntime so this module stays free of a cycle back into runtime.ts; the runtime supplies it as a host object. */
export interface ChatTransportPort {
  readonly cwd: string | undefined;
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  readonly sandboxPerChat: boolean;
  readonly perChatConversationBound: boolean;
  readonly registry: ToolRegistry;
  /** Live read, not a value captured at host-construction time — tests (and the /model-fallback surface) reassign this on the runtime after construction. */
  readonly agentFallbacks: AgentFallbackEntry[];
  /** Live read, not a value captured at host-construction time — see agentFallbacks. */
  readonly nlRoutingEnabled: boolean;
  readonly shared: boolean;
  readonly instanceName: string;
  readonly messenger: Messenger;
  readonly effectiveProvider: string;
  readonly queue: IOutboundQueue | null;
  readonly operationTracker: OperationTracker | null;
  readonly chatSessions: Map<string, SessionManager>;
  readonly chatQueues: Map<string, IOutboundQueue>;
  readonly outboundQueues: Map<string, IOutboundQueue>;
  readonly perChatExecActorQueue: Map<string, (string | undefined)[]>;
  readonly perChatSocketResources: Map<
    string,
    { socketServer: WhatSoupSocketServer; socketPath: string; cfgPath: string }
  >;
  readonly operationTrackers: Map<string, OperationTracker>;
  resolvePerChatMapKey(chatJid: string): string;
  /**
   * Sibling-call delegates. Each routes back through the runtime's own
   * (spy-able) private method rather than calling the peer free function in
   * this module directly — the original code reached these through `this.`,
   * so a caller (test or otherwise) that mocks the runtime's method must
   * still intercept the call. Only the functions actually called by another
   * function in this module need an entry here.
   */
  resolveExecutingActor(chatJid: string): string | undefined;
  derivePerChatSocketPath(chatJid: string): string;
  teardownPerChatActorSocket(mapKey: string): void;
  createPerChatActorSocket(mapKey: string, chatJid: string): { socketPath: string; cfgPath: string };
  exposedCliProviders(): string[];
  getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null;
}

export function resolveExecutingActor(port: ChatTransportPort, chatJid: string): string | undefined {
  const mapKey = port.resolvePerChatMapKey(chatJid);
  const session = port.chatSessions.get(mapKey);
  if (!session || !session.getStatus().active) return undefined;
  return port.perChatExecActorQueue.get(mapKey)?.[0];
}

/** F-STICKY-ACTOR (QR-247): per-chat socket path under <cwd>/.claude, sha1-shortened if it would exceed the unix sun_path limit. */
export function derivePerChatSocketPath(port: ChatTransportPort, chatJid: string): string {
  const dir = join(port.cwd ?? homedir(), '.claude');
  const key = toConversationKey(chatJid);
  const full = join(dir, `whatsoup-${key}.sock`);
  if (Buffer.byteLength(full, 'utf8') <= 100) return full;
  const h = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(dir, `whatsoup-${h}.sock`);
}

/** F-STICKY-ACTOR (QR-247): true only for the mode the fix covers — claude-cli, per_chat, non-sandbox. Gates the global-broadcast SKIP (keep the shared global socket actor-less = fail-closed) and the exec-queue push. Instance-global by design: the global socket's fail-closed property must not depend on per-chat socket timing. */
export function usesPerChatActorSocket(port: ChatTransportPort): boolean {
  return port.sessionScope === 'per_chat' && !port.sandboxPerChat && port.effectiveProvider === 'claude-cli';
}

/**
 * F-STICKY-ACTOR (QR-247): create this chat's own MCP socket (tier:'global',
 * bound to resolveExecutingActor) and write its per-session --mcp-config so the
 * subprocess talks to it instead of the shared global socket. Returns the socket
 * + cfg paths for the provider override. Torn down in cleanupPerChatState.
 *
 * #1785 rec-3: this socket's SessionContext also carries conversationKey, bound
 * once here to the chat it will exclusively serve for its entire lifetime (a
 * fresh socket is derived per chat — see derivePerChatSocketPath — and never
 * reused across chats, so a static bind is race-free, unlike the shared global
 * socket's per-turn rebind in bindActiveGlobalMcpConversation). Without it, the
 * registry's cross-conversation guard and the send-pipeline's beforeAudit check
 * (both gated on session.conversationKey) silently fail open for every send
 * this per-chat actor subprocess makes.
 */
export function createPerChatActorSocket(
  port: ChatTransportPort,
  mapKey: string,
  chatJid: string,
): { socketPath: string; cfgPath: string } {
  const socketPath = port.derivePerChatSocketPath(chatJid);
  // Ensure <cwd>/.claude exists (mirrors the global-socket setup at startup). In
  // production the dir already exists; wiring now runs from more spawn paths
  // (resume / provider-fallback), so make socket creation self-sufficient.
  mkdirSync(join(port.cwd ?? homedir(), '.claude'), { recursive: true, mode: 0o700 });
  const cfgPath = socketPath.replace(/\.sock$/, '.mcp.json');
  const proxyScriptPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/whatsoup-proxy.ts');
  writeMcpConfigToPath('claude-cli', cfgPath, socketPath, proxyScriptPath);
  const socketServer = new WhatSoupSocketServer(
    socketPath,
    port.registry,
    perChatActorSession(chatJid, port.cwd ?? homedir(), port.perChatConversationBound),
    () => port.resolveExecutingActor(chatJid),
  );
  socketServer.start();
  port.perChatSocketResources.set(mapKey, { socketServer, socketPath, cfgPath });
  return { socketPath, cfgPath };
}

/**
 * F-STICKY-ACTOR (QR-247 hardening): the single seam that binds a per-chat
 * session to its own actor socket, keyed on the ACTUAL session provider
 * (route?.provider ?? effectiveProvider) — NOT the instance-global provider.
 * Called from createSessionManager so the ensure / proactive-resume / provider-
 * fallback spawn paths all bind identically. claude-cli non-sandbox per_chat ->
 * create-or-reuse the socket and return the strict --mcp-config override; any
 * other provider -> tear down a stale socket (so a fallback subprocess now on the
 * shared global socket is not frozen behind the presence-based broadcast gate)
 * and return undefined.
 */
export function wirePerChatActorSocket(
  port: ChatTransportPort,
  chatJid: string,
  provider: string,
):
  | { mcpSocketPath: string; providerConfigOverride: { mcpConfig: string[]; strictMcpConfig: true } }
  | undefined {
  if (port.sessionScope !== 'per_chat' || port.sandboxPerChat) return undefined;
  const mapKey = port.resolvePerChatMapKey(chatJid);
  if (provider !== 'claude-cli') {
    port.teardownPerChatActorSocket(mapKey);
    return undefined;
  }
  const existing = port.perChatSocketResources.get(mapKey);
  const { socketPath, cfgPath } = existing
    ? { socketPath: existing.socketPath, cfgPath: existing.cfgPath }
    : port.createPerChatActorSocket(mapKey, chatJid);
  return { mcpSocketPath: socketPath, providerConfigOverride: { mcpConfig: [cfgPath], strictMcpConfig: true } };
}

/** F-STICKY-ACTOR (QR-247 hardening): stop + unlink a per-chat actor socket and clear its exec-queue. Idempotent — safe when no entry exists. */
export function teardownPerChatActorSocket(port: ChatTransportPort, mapKey: string): void {
  port.perChatExecActorQueue.delete(mapKey);
  const sockRes = port.perChatSocketResources.get(mapKey);
  if (sockRes) {
    try { sockRes.socketServer.stop(); } catch (err) { log.warn({ err, mapKey }, 'per-chat socket stop failed'); }
    try { unlinkSync(sockRes.cfgPath); } catch { /* best-effort */ }
    port.perChatSocketResources.delete(mapKey);
  }
}

/** F-STICKY-ACTOR (QR-247): non-claude subprocess CLI providers (PRIMARY and/or configured FALLBACK) that stay on the shared global socket for this instance — the still-uncovered actor-race exposure. */
export function exposedCliProviders(port: ChatTransportPort): string[] {
  const isExposedCli = (p: string | undefined): p is string =>
    typeof p === 'string' && p.endsWith('-cli') && p !== 'claude-cli';
  const providers = new Set<string>();
  if (isExposedCli(port.effectiveProvider)) providers.add(port.effectiveProvider);
  for (const entry of port.agentFallbacks) if (isExposedCli(entry.provider)) providers.add(entry.provider);
  return [...providers];
}

/** F-STICKY-ACTOR (QR-247): true when a non-sandbox per_chat instance has ANY non-claude subprocess CLI provider on the shared global socket, so the concurrent-sender actor race is NOT closed for it. Covers the STATIC config surface (primary OR fallback) and — QR-263 — the DYNAMIC nlRouting surface (a live per-sender pin can select a non-claude CLI provider at runtime even when the static config is claude-only). Drives the honest startup warning (F11). */
export function perChatActorRaceExposed(port: ChatTransportPort): boolean {
  if (port.sessionScope !== 'per_chat' || port.sandboxPerChat) return false;
  return port.exposedCliProviders().length > 0 || port.nlRoutingEnabled;
}

export function findMapKeyForSession(
  port: ChatTransportPort,
  session: SessionManager | undefined,
  fallbackMapKey?: string,
): string | null {
  if (session) {
    for (const [mapKey, currentSession] of port.chatSessions) {
      if (currentSession === session) return mapKey;
    }
  }
  if (fallbackMapKey && port.chatSessions.has(fallbackMapKey)) {
    return fallbackMapKey;
  }
  return null;
}

/**
 * Get the outbound queue for a specific chatJid (shared mode).
 * Falls back to single queue (non-shared mode).
 */
export function getQueueForChat(port: ChatTransportPort, chatJid: string, mapKey?: string): IOutboundQueue | null {
  if (port.sessionScope === 'per_chat') {
    return port.chatQueues.get(mapKey ?? port.resolvePerChatMapKey(chatJid)) ?? null;
  }
  if (port.shared) {
    return port.outboundQueues.get(chatJid) ?? null;
  }
  return port.queue;
}

/**
 * Create an OperationTracker for a session and wire its callbacks to the
 * appropriate queue and session methods. Returns null if tracking is disabled.
 */
export function createOperationTracker(
  port: ChatTransportPort,
  session: SessionManager,
  resolveQueue: () => IOutboundQueue | null | undefined,
): OperationTracker | null {
  if (!config.operationTracker?.enabled) return null;
  return new OperationTracker(
    port.instanceName,
    config.operationTracker,
    {
      onProgress: (event: ProgressEvent) => {
        const q = resolveQueue();
        if (q) q.enqueueProgressUpdate(event, port.instanceName);
      },
      onStalled: (toolId: string, toolName: string) => {
        session.recoverStalledOperation(toolId, toolName);
      },
      onThinkingStalled: () => {
        session.probeLiveness();
      },
    },
  );
}

/** Resolve the operation tracker for a given mapKey (per_chat) or the singleton (single/shared).
 *  Always checks the per-key map first — control sessions store their tracker there even in
 *  single/shared scope, so the map lookup must precede the singleton fallback to prevent
 *  control session stalls from triggering recovery on the main session's process. */
export function getTracker(port: ChatTransportPort, mapKey?: string): OperationTracker | null {
  if (mapKey !== undefined) {
    const perKeyTracker = port.operationTrackers.get(mapKey);
    if (perKeyTracker) return perKeyTracker;
  }
  if (port.sessionScope === 'per_chat') return null;
  return port.operationTracker;
}

export function sendDirect(port: ChatTransportPort, chatJid: string, text: string, bypassEchoGuard = false): void {
  if (bypassEchoGuard) {
    // Bypass queue entirely — direct send for admin responses
    port.messenger.sendMessage(chatJid, text).catch((err) =>
      log.error({ err }, 'sendDirect bypass failed'),
    );
    return;
  }
  const queue = port.getQueueForChat(chatJid);
  if (queue) {
    queue.enqueueText(text);
  } else {
    port.messenger.sendMessage(chatJid, text).catch((err) =>
      log.error({ err }, 'sendDirect fallback failed'),
    );
  }
}
