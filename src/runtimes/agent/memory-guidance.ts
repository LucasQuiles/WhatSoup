// src/runtimes/agent/memory-guidance.ts
// System-prompt guidance for the agent's long-term memory tools.
//
// Agent instances have no automatic memory write path (enrichment and
// consolidation run on chat instances only), so a memory is saved only when the
// model chooses memory_write. The tool description alone has not led models to
// use it; this block says what to save, what never to save, and how far a saved
// memory reaches.
//
// A session gets the block when memory is usable for this instance and
// memory_write is listed for the session and allowed by any explicit sandbox
// MCP allowlist. "Usable" means startup readiness was ready, or its provider
// call failed only transiently, so a startup timeout or outage cannot hide the
// guidance for the whole process lifetime (memory_write reports its own
// errors). A local refusal or a definitive provider answer hides it.
//
// The reach sentence must stay true to src/core/memory-scope.ts. memory_write
// files every record under the calling conversation. Verified admin senders, in
// any chat including groups with other people, and contacts set to 'instance'
// rank other chats in. The operator instance recalls every chat everywhere.

import type {
  MemoryEvidenceCoverage,
  MemoryOperationFailureCode,
  MemoryReadinessState,
} from '../../lib/memory-operation-telemetry.ts';
import { isOperatorInstance } from '../../lib/pinecone-project-guard.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import { noExecutingSession, resolveSessionContext, type SessionContext } from '../../mcp/types.ts';

/** The fields of the startup readiness observation (pinecone.ts) the gate reads. */
export interface MemoryReadinessSnapshot {
  state: MemoryReadinessState;
  failureCode: MemoryOperationFailureCode;
  evidenceCoverage: MemoryEvidenceCoverage;
}

/**
 * Startup provider failures that may clear while the process runs, as
 * classifyMemoryOperationFailure names them: timeout (408, ETIMEDOUT, abort),
 * network_error, provider_unavailable (5xx) and rate_limited (429). Every other
 * code, auth_failed (401/403), invalid_request and unknown included, is treated
 * as definitive.
 */
const TRANSIENT_STARTUP_FAILURES: ReadonlySet<MemoryOperationFailureCode> = new Set([
  'timeout',
  'network_error',
  'provider_unavailable',
  'rate_limited',
]);

const MEMORY_REACH =
  "- Memories are saved to this chat. The bot's admins, and contacts they allow, can recall them from other chats, and an admin can do so even in a group with other people.";
const OPERATOR_MEMORY_REACH =
  '- Memories are saved to this chat. On this instance every chat can recall them.';

export function buildMemoryGuidance(opts: { operatorInstance: boolean; searchesMemory: boolean }): string {
  return [
    'Long-term memory (memory_write):',
    '- Save only what will matter in a later conversation: a lasting fact, plan or arrangement (memory_type user_fact, or group_context for facts about a group), a preference (preference), a fix to something saved before (correction), or anything the person asks you to remember.',
    opts.searchesMemory
      ? '- Check knowledge_search first, before saving and before asking something the person may already have told you; do not save the same thing twice.'
      : '- Do not save the same thing twice.',
    "- Never save passwords, keys, codes or payment details, even if asked; say you can't keep those.",
    '- Save health details or details about other people only when the person asks you to remember them.',
    opts.operatorInstance ? OPERATOR_MEMORY_REACH : MEMORY_REACH,
  ].join('\n');
}

/**
 * Memory is usable when startup readiness (getPineconeReadinessObservation) was
 * `ready`, or its provider call failed transiently. A local refusal
 * (`local_guard`: no index, no key, no project guard) and a definitive provider
 * answer (`index_missing`, `project_mismatch`, an auth rejection) are not.
 */
export function memoryUsable(readiness: MemoryReadinessSnapshot | undefined): boolean {
  if (readiness?.state === 'ready') return true;
  return readiness?.evidenceCoverage === 'provider_error' && TRANSIENT_STARTUP_FAILURES.has(readiness.failureCode);
}

/** deploy/hooks/agent-sandbox.sh's MCP rule: an absent or empty allowlist allows every tool. */
function sandboxAllows(allowedMcpTools: readonly string[] | undefined, name: string): boolean {
  return !allowedMcpTools?.length
    || allowedMcpTools.includes(name)
    || allowedMcpTools.includes(`mcp__whatsoup__${name}`);
}

/** The indexes knowledge_search accepts: its listed `index` enum (allowedIndexes that have a profile, knowledge.ts). */
function searchableIndexes(inputSchema: Record<string, unknown> | undefined): unknown[] {
  const properties = inputSchema?.['properties'] as Record<string, { enum?: unknown } | undefined> | undefined;
  const values = properties?.['index']?.enum;
  return Array.isArray(values) ? values : [];
}

/**
 * The `memoryGuidanceBlock` callback for a new SessionManager, or undefined
 * (prompt stays byte-identical) when memory is not usable, memory_write is
 * not listed for `session`, or an explicit sandbox allowlist omits it. The
 * knowledge_search line needs that tool to accept `memoryIndex`, the index
 * memory_write writes to.
 */
export function memoryGuidanceSystemBlock(input: {
  readiness: MemoryReadinessSnapshot | undefined;
  registry: Pick<ToolRegistry, 'listTools'>;
  session: SessionContext;
  instanceName: string;
  memoryIndex: string;
  allowedMcpTools: readonly string[] | undefined;
}): (() => string) | undefined {
  if (!memoryUsable(input.readiness)) return undefined;
  // This checks registration, not per-session tool filtering. Listing filters
  // only by tier, conversation binding and the scheduled-job forbidden set
  // (registry.ts sessionWouldList). Both memory tools are chat-scope tools
  // outside that set, so every session lists them once they are registered,
  // and the blank executing context changes nothing for them.
  const tools = new Map(
    input.registry.listTools(resolveSessionContext(input.session, noExecutingSession())).map((tool) => [tool.name, tool]),
  );
  if (!tools.has('memory_write') || !sandboxAllows(input.allowedMcpTools, 'memory_write')) return undefined;
  const search = tools.get('knowledge_search');
  const block = buildMemoryGuidance({
    operatorInstance: isOperatorInstance(input.instanceName),
    searchesMemory: search !== undefined
      && sandboxAllows(input.allowedMcpTools, 'knowledge_search')
      && searchableIndexes(search.inputSchema).includes(input.memoryIndex),
  });
  return () => block;
}
