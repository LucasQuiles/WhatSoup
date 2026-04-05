// src/mcp/register-all.ts
// Standalone function that registers all 13 tool modules onto a ToolRegistry.
// Used by AgentRuntime and PassiveRuntime so both get the same 116 tools.

import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolDeclaration, ExtendedBaileysSocket } from './types.ts';
import type { Database } from '../core/database.ts';
import type { ConnectionManager } from '../transport/connection.ts';
import { registerMessagingTools } from './tools/messaging.ts';
import { registerMediaTools } from './tools/media.ts';
import { registerChatManagementTools } from './tools/chat-management.ts';
import { registerChatOperationTools } from './tools/chat-operations.ts';
import { registerSearchTools } from './tools/search.ts';
import { registerGroupTools } from './tools/groups.ts';
import { registerCommunityTools } from './tools/community.ts';
import { registerNewsletterTools } from './tools/newsletter.ts';
import { registerBusinessTools } from './tools/business.ts';
import { registerAdvancedTools } from './tools/advanced.ts';
import { registerCallTools } from './tools/calls.ts';
import { registerPresenceTools } from './tools/presence.ts';
import { registerProfileTools } from './tools/profile.ts';
import { registerKnowledgeTools } from './tools/knowledge.ts';

const log = createChildLogger('register-all');

/**
 * Register all 13 tool modules onto the given registry.
 *
 * Preserves the three calling conventions used by the individual modules:
 *   Pattern 1 (options-object): registerMessagingTools, registerMediaTools
 *   Pattern 2 (DB-dependent):   registerChatManagementTools, registerChatOperationTools, registerSearchTools
 *   Pattern 3 (socket+callback): all remaining modules
 */
export function registerAllTools(
  registry: ToolRegistry,
  connection: ConnectionManager,
  db: Database,
): void {
  const getSock = () => connection.getSocket() as ExtendedBaileysSocket | null;
  const register = (tool: ToolDeclaration) => {
    try {
      registry.register(tool);
    } catch (err) {
      log.error({ err, tool: tool.name }, 'failed to register tool');
    }
  };

  // Pattern 1 — options-object: take ToolRegistry + deps directly
  try { registerMessagingTools(registry, { connection, db: db.raw }); } catch (err) { log.error({ err }, 'registerMessagingTools failed'); }
  try { registerMediaTools(registry, { connection, db: db.raw }); } catch (err) { log.error({ err }, 'registerMediaTools failed'); }

  // Pattern 2 — DB-dependent
  try { registerChatManagementTools(db, getSock, register); } catch (err) { log.error({ err }, 'registerChatManagementTools failed'); }
  try { registerChatOperationTools(db, getSock, register); } catch (err) { log.error({ err }, 'registerChatOperationTools failed'); }
  try { registerSearchTools(db, register); } catch (err) { log.error({ err }, 'registerSearchTools failed'); }

  // Pattern 3 — socket+callback
  try { registerGroupTools(getSock, register); } catch (err) { log.error({ err }, 'registerGroupTools failed'); }
  try { registerCommunityTools(getSock, register); } catch (err) { log.error({ err }, 'registerCommunityTools failed'); }
  try { registerNewsletterTools(getSock, register); } catch (err) { log.error({ err }, 'registerNewsletterTools failed'); }
  try { registerBusinessTools(getSock, register); } catch (err) { log.error({ err }, 'registerBusinessTools failed'); }
  try { registerAdvancedTools(getSock, register, db); } catch (err) { log.error({ err }, 'registerAdvancedTools failed'); }
  try { registerCallTools(getSock, register); } catch (err) { log.error({ err }, 'registerCallTools failed'); }
  try { registerProfileTools(getSock, db, register); } catch (err) { log.error({ err }, 'registerProfileTools failed'); }

  // Presence needs the shared presenceCache from ConnectionManager
  try { registerPresenceTools(getSock, connection.presenceCache, register); } catch (err) { log.error({ err }, 'registerPresenceTools failed'); }

  // Knowledge search — only when instance config specifies allowed indexes
  const allowedIndexes: string[] = Array.isArray(config.pineconeAllowedIndexes) ? config.pineconeAllowedIndexes : [];
  if (allowedIndexes.length > 0) {
    try { registerKnowledgeTools(allowedIndexes, register); } catch (err) { log.error({ err }, 'registerKnowledgeTools failed'); }
  }

  log.info({ toolCount: registry.listTools({ tier: 'global' }).length }, 'all tools registered');
}
