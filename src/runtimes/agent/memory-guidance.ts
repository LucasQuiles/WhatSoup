// src/runtimes/agent/memory-guidance.ts
// System-prompt guidance for the agent's long-term memory tools.
//
// Agent instances have no automatic memory write path (enrichment and
// consolidation run on chat instances only), so a memory is saved only when the
// model chooses memory_write. The tool description alone has not led models to
// use it; this block says when to save, what never to save, and how far a
// saved memory reaches. A session gets it only when Pinecone memory was ready
// at startup and memory_write is listed for that session's tool context, so it
// never points the model at a tool it cannot call.
//
// The reach sentence must stay true to src/core/memory-scope.ts. memory_write
// files every record under the calling conversation. A non-admin contact's
// direct chat and a group with other members recall only their own chat;
// admin senders, contacts set to 'instance' and owner-only groups also rank
// other chats in. The operator instance recalls every chat everywhere.

import { isOperatorInstance } from '../../lib/pinecone-project-guard.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import { noExecutingSession, resolveSessionContext, type SessionContext } from '../../mcp/types.ts';

const MEMORY_REACH =
  "- Memories are saved to this chat. Outside this chat, only the bot's admins and contacts they allow can recall them; groups with other people cannot.";
const OPERATOR_MEMORY_REACH =
  '- Memories are saved to this chat. On this instance every chat can recall them.';

export function buildMemoryGuidance(opts: { operatorInstance: boolean; knowledgeSearch: boolean }): string {
  return [
    'Long-term memory (memory_write):',
    '- Save a memory with memory_write when the person states a lasting fact, preference, decision or commitment, or asks you to remember something.',
    opts.operatorInstance ? OPERATOR_MEMORY_REACH : MEMORY_REACH,
    '- Never save passwords, keys, codes, payment details, health details, or private details about anyone other than the person you are talking to.',
    ...(opts.knowledgeSearch
      ? ['- Before asking the person something they may already have told you, check memory with knowledge_search.']
      : []),
  ].join('\n');
}

/**
 * The `memoryGuidanceBlock` callback for a new SessionManager, or undefined
 * (prompt stays byte-identical) when memory was not ready at startup or
 * memory_write is not listed for `session`. Listing uses the session's static
 * tool context; memory_write is outside the scheduled-job forbidden set, so an
 * unresolved executing context lists it exactly as a live turn would.
 */
export function memoryGuidanceSystemBlock(input: {
  memoryReady: boolean;
  registry: Pick<ToolRegistry, 'listTools'>;
  session: SessionContext;
  instanceName: string;
}): (() => string) | undefined {
  if (!input.memoryReady) return undefined;
  const listed = new Set(
    input.registry.listTools(resolveSessionContext(input.session, noExecutingSession())).map((tool) => tool.name),
  );
  if (!listed.has('memory_write')) return undefined;
  const block = buildMemoryGuidance({
    operatorInstance: isOperatorInstance(input.instanceName),
    knowledgeSearch: listed.has('knowledge_search'),
  });
  return () => block;
}
