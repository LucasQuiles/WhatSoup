// src/mcp/tools/memory-write.ts
// Agent-facing MCP tool: write an episodic memory record to the instance's
// configured per-person Pinecone index (memory.pinecone.index), via the same
// integrated-embedding upsert path the chat runtime uses (PineconeMemory.upsert).
//
// Why this exists: agent instances do NOT run the chat-runtime enrichment poller
// (that path is chat-instance only — see main.ts), so an agent bot like ph-bot
// has no way to persist what it learns. This tool gives the agent an explicit,
// chat-scoped WRITE primitive into its OWN isolated Pinecone project.
//
// Security/scope contract (ITEM 2 decisions):
//   - scope: 'chat', targetMode: 'injected' — chatJid auto-filled from the session;
//     no cross-conversation writes from a chat-scoped session.
//   - senderJid is DERIVED, never caller-supplied (anti-spoofing): 'self_fact' →
//     the bot's own JID; otherwise the session actor (the human in the chat).
//   - The configured Pinecone project guard is enforced by PineconeMemory.upsert.

import { z } from 'zod';
import { shortHash } from '../../lib/short-hash.ts';
import { createChildLogger } from '../../logger.ts';
import { PineconeMemory, type MemoryRecord } from '../../runtimes/chat/providers/pinecone.ts';
import { conversationBoundKey, errorResult, type ToolDeclaration } from '../types.ts';

const log = createChildLogger('memory-write');

/** Minimal writer seam so tests can inject a fake without constructing a live client. */
export interface MemoryWriter {
  upsert(records: MemoryRecord[]): Promise<void>;
}

const MEMORY_TYPES = ['user_fact', 'group_context', 'preference', 'correction', 'self_fact'] as const;

const MemoryWriteSchema = z.object({
  // Injected target (stripped from the exposed schema in chat-scoped sessions,
  // auto-filled from session.deliveryJid by the registry).
  chatJid: z.string(),
  text: z.string().min(1).max(2000),
  memory_type: z.enum(MEMORY_TYPES),
  confidence: z.number().min(0).max(1).optional(),
  claim: z.string().max(2000).optional(),
  evidence: z.string().max(2000).optional(),
  warrant: z.string().max(2000).optional(),
  contradicts: z.string().max(2000).optional(),
});

function stableId(chatKey: string, memoryType: string, text: string): string {
  const h = shortHash(JSON.stringify([chatKey, memoryType, text]), 24);
  return `${memoryType}_${h}`;
}

/**
 * Register the `memory_write` tool.
 *
 * @param register   registry register callback
 * @param makeWriter optional writer factory (defaults to a live PineconeMemory) — injectable for tests
 */
export function registerMemoryWriteTools(
  register: (tool: ToolDeclaration) => void,
  makeWriter: () => MemoryWriter = () => new PineconeMemory(),
): void {
  let writer: MemoryWriter | null = null;
  const getWriter = (): MemoryWriter => (writer ??= makeWriter());

  register({
    name: 'memory_write',
    description:
      'Persist a durable memory about this conversation to your long-term memory store. ' +
      'Use for facts, preferences, and corrections worth remembering across sessions. ' +
      'memory_type: user_fact | group_context | preference | correction. ' +
      'The conversation and the speaker are recorded automatically — do not pass identities.',
    schema: MemoryWriteSchema,
    scope: 'chat',
    targetMode: 'injected',
    core: false,
    replayPolicy: 'unsafe',
    handler: async (params, session) => {
      const p = params as z.infer<typeof MemoryWriteSchema>;
      // Confined sessions ONLY: chat-scoped, or conversation-bound (the
      // per-chat actor socket — tier:'global' but binding-confined to one
      // chat by the registry's default-deny gate and the binding-keyed
      // helpers). In an UNBOUND global session the registry would accept a
      // caller-supplied chatJid (registry.ts global branch) → a
      // cross-conversation write, so those stay refused. File ONLY under the
      // session's own key — binding first (SSOT), never params.chatJid.
      const boundKey = conversationBoundKey(session);
      const rawChat = boundKey ?? (session.tier === 'chat-scoped' ? session.conversationKey : undefined);
      if (!rawChat) {
        return errorResult('memory_write is only available in a chat-scoped or conversation-bound session');
      }

      const memoryType = p.memory_type;
      // QR-082: FORBID self_fact from this chat-scoped tool. self_fact memories are
      // recalled GLOBALLY (searchSelfFacts filters on memory_type only — NO chat_jid
      // filter, pinecone.ts) and injected into EVERY conversation's context under a
      // TRUSTED directive ("Things you have said about yourself before — stay
      // consistent with these", context.ts), unlike user_fact/group_context which
      // recall per-chat/per-sender and, per QR-031, are framed reference-only. A
      // chat-scoped session is steered by UNTRUSTED conversation content (prompt
      // injection), so permitting it to author a global-identity self_fact lets one
      // chat poison the bot's self-identity across ALL chats. self_fact must originate
      // ONLY from the trusted/global path (enrichment/config), never from this
      // per-chat write primitive — which restores the trusted-author invariant the
      // "stay consistent" recall framing already assumes.
      if (memoryType === 'self_fact') {
        return errorResult(
          'memory_write cannot write a self_fact from a chat-scoped session — global self-identity memories must originate from a trusted source, not per-chat input',
        );
      }
      // Sender is DERIVED from the session actor, never caller-supplied; FAIL CLOSED
      // if it cannot be resolved — never write a placeholder/empty sender. (self_fact,
      // the only case that used the bot's own JID, is rejected above — QR-082.)
      const senderJid = session.actorJid;
      if (!senderJid) {
        return errorResult('memory_write could not resolve a sender identity');
      }

      const now = new Date().toISOString();
      const record: MemoryRecord = {
        id: stableId(rawChat, memoryType, p.text),
        text: p.text,
        chatJid: rawChat,
        senderJid,
        senderName: '',
        memoryType,
        confidence: p.confidence ?? 0.8,
        createdAt: now,
        updatedAt: now,
        superseded: 'false',
        sourceMessagePks: '',
        ...(p.claim !== undefined ? { claim: p.claim } : {}),
        ...(p.evidence !== undefined ? { evidence: p.evidence } : {}),
        ...(p.warrant !== undefined ? { warrant: p.warrant } : {}),
        ...(p.contradicts !== undefined ? { contradicts: p.contradicts } : {}),
      };

      try {
        await getWriter().upsert([record]);
      } catch (err) {
        log.warn({ err, memoryType }, 'memory_write upsert failed');
        return errorResult(`memory_write failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      return { id: record.id, status: 'written', memory_type: memoryType };
    },
  });
}
