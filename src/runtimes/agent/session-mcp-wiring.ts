// src/runtimes/agent/session-mcp-wiring.ts
//
// Pure wiring for one SessionManager's MCP surface: the tool session its
// in-process bridge serves, the binding of the session token its child
// presents on a socket, its provider MCP config arguments, and the provider
// MCP canary admission gate. Moved out
// of AgentRuntime.createSessionManager unchanged; the runtime still decides
// every input and owns every check's call site.

import { homedir } from 'node:os';
import { workspaceSocketPath } from '../../core/workspace-paths.ts';
import type { SessionTokenBinding } from '../../mcp/caller-attribution.ts';
import type { SessionContext } from '../../mcp/types.ts';
import { canaryStoreProvisioned, readProviderCanaryAdmission, type ProviderAdmission } from './provider-canary-proof.ts';
import { buildProviderMcpConfigArgs } from './providers/mcp-bridge.ts';
import { isScheduledAgentJobMapKey } from './scheduled-agent-job-isolation.ts';
import { getProviderBinary } from './session.ts';

export interface ProviderToolSessionInput {
  /** True for sandboxPerChat or per_chat runtimes: the session serves one chat. */
  chatScoped: boolean;
  /** Shared runtimes keep a global session unbound to any conversation. */
  shared: boolean;
  chatJid: string;
  deliveryConversationKey: string;
  sessionConversationKey: string;
  actorJid?: string;
  cwd?: string;
  turnReplySessionId: string;
}

/** The tool session a new SessionManager's provider bridge serves. Callers may add a reply sink later. */
export function buildProviderToolSession(input: ProviderToolSessionInput): SessionContext {
  const providerToolSession: SessionContext =
    input.chatScoped
      ? {
          tier: 'chat-scoped',
          conversationKey: input.deliveryConversationKey,
          deliveryJid: input.chatJid,
          ...(input.actorJid ? { actorJid: input.actorJid } : {}),
          ...(input.cwd ? { allowedRoot: input.cwd } : {}),
          ...(isScheduledAgentJobMapKey(input.sessionConversationKey)
            ? { purpose: 'scheduled-agent-job' as const }
            : {}),
        }
      : {
          tier: 'global',
          ...(input.actorJid ? { actorJid: input.actorJid } : {}),
          ...(!input.shared ? { conversationKey: input.deliveryConversationKey } : {}),
        };
  providerToolSession.turnReplySessionId = input.turnReplySessionId;
  return providerToolSession;
}

/**
 * The session token's binding: the socket its child is given (the per-chat or
 * global socket, else the sandbox workspace socket) and the manager identity
 * the turn-reply sink resolves.
 */
export function sessionTokenLeaseBinding(input: {
  mcpSocketPath: string | undefined;
  globalMcpSocketPath: string | null;
  sandboxPerChat: boolean;
  cwd: string | undefined;
  turnReplySessionId: string;
}): SessionTokenBinding {
  return {
    kind: 'session',
    socketPath: input.mcpSocketPath ?? input.globalMcpSocketPath ?? (input.sandboxPerChat && input.cwd ? workspaceSocketPath(input.cwd) : ''),
    turnReplySessionId: input.turnReplySessionId,
  };
}

/** The provider's MCP config arguments for the global socket, or none when there is no global socket. */
export function sessionProviderMcpConfigArgs(input: {
  provider: string;
  cwd: string | undefined;
  globalMcpSocketPath: string | null;
  proxyScriptPath: string;
}): readonly string[] {
  return input.globalMcpSocketPath
    ? buildProviderMcpConfigArgs(
        input.provider,
        input.cwd ?? homedir(),
        input.globalMcpSocketPath,
        input.proxyScriptPath,
      )
    : [];
}

/**
 * The provider MCP canary admission a session must pass before spawning, or
 * undefined when no actor socket is required or no canary store is provisioned.
 * The binary is resolved when the admission runs, not when it is built.
 */
export function providerCanaryAdmissionGate(
  actorSocketRequired: boolean,
  input: { providerId: string; proxyScriptPath: string; stateRoot: string; sessionScope: string; sandboxPerChat: boolean },
): (() => Promise<ProviderAdmission>) | undefined {
  return actorSocketRequired && canaryStoreProvisioned(input.stateRoot)
    ? async () => {
        const admission = await readProviderCanaryAdmission({
          providerId: input.providerId,
          binary: getProviderBinary(input.providerId) ?? '',
          proxyScriptPath: input.proxyScriptPath,
          stateRoot: input.stateRoot,
          sessionScope: input.sessionScope,
          sandboxPerChat: input.sandboxPerChat,
        });
        if (!admission.allowed) {
          throw new Error('provider MCP canary proof unavailable');
        }
        return admission;
      }
    : undefined;
}
