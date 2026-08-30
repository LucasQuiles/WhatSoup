import {
  ADMIN_REQUIRED_DENIAL,
  SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS,
  ToolRegistry as ProductionToolRegistry,
} from '../../src/mcp/registry.ts';
import {
  resolveSessionContext,
  type SessionContext,
} from '../../src/mcp/types.ts';

export { ADMIN_REQUIRED_DENIAL, SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS };

function resolveTestSession(session: SessionContext) {
  return resolveSessionContext(session, {
    actorJid: session.actorJid,
    purpose: session.purpose,
    conversationKey: session.conversationKey,
  });
}

/** Test adapter: each direct registry call explicitly snapshots its supplied request context. */
export class ToolRegistry extends ProductionToolRegistry {
  override listTools(session: SessionContext) {
    return super.listTools(resolveTestSession(session));
  }

  override async call(
    name: string,
    params: Record<string, unknown>,
    session: SessionContext,
  ) {
    return super.call(name, params, resolveTestSession(session));
  }
}
