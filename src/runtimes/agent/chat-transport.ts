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
import { createChildLogger } from '../../logger.ts';
import type { Messenger } from '../../core/types.ts';
import type { SessionManager } from './session.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import { OperationTracker, type ProgressEvent } from './operation-tracker.ts';
import type { PerChatMcpSocketManager } from './per-chat-mcp-socket-manager.ts';
import { isProviderId, providerUsesWhatSoupMcp } from './providers/index.ts';

/**
 * Structurally derived from OperationTracker's own constructor rather than
 * imported from src/config.ts directly — a value/type import of config.ts
 * here would be a NEW runtime-code-imports-composition-code ring-boundary
 * violation (guard:ring-boundary-ratchet counts import statements
 * regardless of `import type`; see eslint-rules/ring-boundaries.mjs). This
 * derivation is exactly the config.ts-declared OperationTrackerConfig type
 * with zero extra coupling — runtime.ts already carries the grandfathered
 * config.ts import and threads the concrete value through the port.
 */
type OperationTrackerConfig = ConstructorParameters<typeof OperationTracker>[1];

// Same component name as AgentRuntime: the log lines below keep their
// existing `component: 'agent-runtime'` binding (no observable change).
const log = createChildLogger('agent-runtime');

/** The AgentRuntime surface the per-chat transport helpers read and mutate. Declared here rather than importing AgentRuntime so this module stays free of a cycle back into runtime.ts; the runtime supplies it as a host object. */
export interface ChatTransportPort {
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  readonly sandboxPerChat: boolean;
  readonly shared: boolean;
  readonly instanceName: string;
  readonly messenger: Messenger;
  readonly queue: IOutboundQueue | null;
  readonly operationTracker: OperationTracker | null;
  readonly chatSessions: Map<string, SessionManager>;
  readonly chatQueues: Map<string, IOutboundQueue>;
  readonly outboundQueues: Map<string, IOutboundQueue>;
  readonly perChatExecActorQueue: Map<string, (string | undefined)[]>;
  readonly perChatMcpSocketManager: PerChatMcpSocketManager;
  readonly operationTrackers: Map<string, OperationTracker>;
  /** Threaded from runtime.ts's own `config` import (src/config.ts) rather than importing `config` here — this module stays out of the composition ring, matching the model-pin.ts precedent (createModelPinHost's `nlRoutingTiers: config.nlRoutingTiers`). */
  readonly operationTrackerConfig: OperationTrackerConfig;
  resolvePerChatMapKey(chatJid: string): string;
  /**
   * Sibling-call delegates. Each routes back through the runtime's own
   * (spy-able) private method rather than calling the peer free function in
   * this module directly — the original code reached these through `this.`,
   * so a caller (test or otherwise) that mocks the runtime's method must
   * still intercept the call. Only the functions actually called by another
   * function in this module need an entry here.
   */
  teardownPerChatActorSocket(mapKey: string): void;
  getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null;
}

export function resolveExecutingActor(port: ChatTransportPort, chatJid: string): string | undefined {
  const mapKey = port.resolvePerChatMapKey(chatJid);
  const session = port.chatSessions.get(mapKey);
  if (!session || !session.getStatus().active) return undefined;
  return port.perChatExecActorQueue.get(mapKey)?.[0];
}

/**
 * Bind an eligible per-chat session to the logical conversation's actor socket.
 * Capability is evaluated from the actual selected provider. API-only providers
 * wait for any prior CLI child teardown before they can start; unknown providers
 * fail closed instead of inheriting the shared compatibility socket.
 */
export function wirePerChatActorSocket(
  port: ChatTransportPort,
  chatJid: string,
  provider: string,
):
  | { mcpSocketPath?: string; providerTransitionReady: Promise<void> }
  | undefined {
  if (port.sessionScope !== 'per_chat' || port.sandboxPerChat) return undefined;
  const mapKey = port.resolvePerChatMapKey(chatJid);
  if (!isProviderId(provider)) {
    throw new Error(`unrecognized provider MCP capability: ${provider}`);
  }
  if (!providerUsesWhatSoupMcp(provider)) {
    return {
      providerTransitionReady:
        port.perChatMcpSocketManager.providerTransitionReady(mapKey),
    };
  }
  const { socketPath, ready } = port.perChatMcpSocketManager.acquire(mapKey, chatJid);
  return { mcpSocketPath: socketPath, providerTransitionReady: ready };
}

/** Clear actor publication before releasing the logical session's owned socket. */
export function teardownPerChatActorSocket(port: ChatTransportPort, mapKey: string): void {
  port.perChatExecActorQueue.delete(mapKey);
  port.perChatMcpSocketManager.release(mapKey);
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
  if (!port.operationTrackerConfig?.enabled) return null;
  return new OperationTracker(
    port.instanceName,
    port.operationTrackerConfig,
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
