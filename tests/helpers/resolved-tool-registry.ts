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
    // Direct-registry tests model a REAL (resolved) turn: this adapter snapshots
    // a caller-built session rather than reading a live executing-turn register,
    // so a bare `{tier:'global'}` test session is resolved-normal, not the
    // unresolved empty-context state (#3435). Assert resolution UNCONDITIONALLY —
    // never derive it from the session fields, which would re-create the very
    // all-undefined ambiguity the discriminator exists to remove. Tests that
    // exercise the UNRESOLVED path must NOT use this adapter (they would be
    // rescued to resolved here and pass vacuously) — construct the resolved
    // context directly with `noExecutingSession()` / an empty executing context.
    resolved: true,
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
