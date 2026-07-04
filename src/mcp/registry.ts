import {
  z,
  ZodType,
  ZodString,
  ZodNumber,
  ZodBoolean,
  ZodOptional,
  ZodArray,
  ZodEnum,
  ZodObject,
  ZodRecord,
} from 'zod';
import { toConversationKey } from '../core/conversation-key.ts';
import { createChildLogger } from '../logger.ts';
import type { DurabilityEngine } from '../core/durability.ts';
import { isToolErrorPayload, type ToolDeclaration, type ToolCallResult, type SessionContext } from './types.ts';
import { errorMessage } from '../lib/error-message.ts';

const log = createChildLogger('ToolRegistry');

// ---------------------------------------------------------------------------
// Zod → JSON Schema (minimal, handles the types we use in tool declarations)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function withZodDescription(schema: ZodType, jsonSchema: JsonSchema): JsonSchema {
  return schema.description
    ? { ...jsonSchema, description: schema.description }
    : jsonSchema;
}

function zodToJsonSchema(schema: ZodType): JsonSchema {
  if (schema instanceof ZodString) {
    return withZodDescription(schema, { type: 'string' });
  }

  if (schema instanceof ZodNumber) {
    return withZodDescription(schema, { type: 'number' });
  }

  if (schema instanceof ZodBoolean) {
    return withZodDescription(schema, { type: 'boolean' });
  }

  if (schema instanceof ZodOptional) {
    // Unwrap and mark the inner type while preserving descriptions attached after .optional().
    return withZodDescription(schema, zodToJsonSchema(schema.unwrap()));
  }

  if (schema instanceof ZodArray) {
    return withZodDescription(schema, {
      type: 'array',
      items: zodToJsonSchema(schema.element),
    });
  }

  if (schema instanceof ZodEnum) {
    return withZodDescription(schema, {
      type: 'string',
      enum: schema.options as string[],
    });
  }

  if (schema instanceof ZodRecord) {
    return withZodDescription(schema, { type: 'object' });
  }

  if (schema instanceof ZodObject) {
    const shape = schema.shape as Record<string, ZodType>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!(fieldSchema instanceof ZodOptional)) {
        required.push(key);
      }
    }

    const result: JsonSchema = { type: 'object', properties };
    if (required.length > 0) {
      result.required = required;
    }
    return withZodDescription(schema, result);
  }

  // Fallback for unrecognised types
  return withZodDescription(schema, {});
}

function schemaHasProperty(tool: ToolDeclaration, propertyName: string): boolean {
  const schema = zodToJsonSchema(tool.schema);
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  return properties !== undefined && Object.prototype.hasOwnProperty.call(properties, propertyName);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build a JSON Schema for tools/list output.
 *
 * - Global sessions + injected tools: `chatJid` is ensured present as a
 *   required string property (it may already be in the Zod schema; we
 *   normalise to guarantee it).
 * - Chat-scoped sessions + injected tools: `chatJid` is stripped from both
 *   `properties` and `required`. The registry auto-fills it from the session
 *   at call time; exposing it would be misleading and would reveal the
 *   injection mechanism to the caller.
 * - All other cases: return the base schema unchanged.
 */
function buildListSchema(
  tool: ToolDeclaration,
  session: SessionContext,
): JsonSchema {
  const base = zodToJsonSchema(tool.schema);

  if (tool.targetMode !== 'injected') {
    return base;
  }

  const props: Record<string, JsonSchema> =
    { ...((base.properties as Record<string, JsonSchema>) ?? {}) };
  const existingRequired: string[] = (base.required as string[]) ?? [];
  const supportsAliasTarget = Object.prototype.hasOwnProperty.call(props, 'to');

  if (session.tier === 'chat-scoped') {
    // Strip caller targets — chatJid is auto-filled from session.deliveryJid
    // at call time, and alias targets must not retarget a chat-scoped session.
    delete props['chatJid'];
    if (supportsAliasTarget) delete props['to'];
    return {
      ...base,
      properties: props,
      required: existingRequired.filter((k) => k !== 'chatJid' && k !== 'to'),
    };
  }

  if (supportsAliasTarget) {
    return {
      ...base,
      properties: {
        chatJid: { type: 'string' },
        ...props,
      },
      required: existingRequired.filter((k) => k !== 'chatJid' && k !== 'to'),
    };
  }

  // Global session: ensure chatJid is present and required.
  return {
    ...base,
    properties: {
      chatJid: { type: 'string' },
      ...props,
    },
    required: ['chatJid', ...existingRequired.filter((k) => k !== 'chatJid')],
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDeclaration>();
  private durability: DurabilityEngine | undefined;
  private sensitiveAuthorizer: ((session: SessionContext) => boolean) | null = null;

  /** Attach a DurabilityEngine to record tool calls. */
  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
  }

  /**
   * Install the instance's admin predicate for `sensitive`-flagged tools
   * (R1). Until installed, sensitive tools deny everything — a registry
   * carrying sensitive tools without an authorizer is fail-closed by
   * construction.
   */
  setSensitiveToolAuthorizer(fn: (session: SessionContext) => boolean): void {
    if (this.sensitiveAuthorizer) {
      // Single install site in production; a second install would silently
      // reassign the admin policy for every sensitive tool. Fail loud.
      throw new Error('sensitive-tool authorizer already installed');
    }
    this.sensitiveAuthorizer = fn;
  }

  /**
   * R1 central gate, evaluated per CALL with the turn's actor. Fail-closed
   * on every uncertain path: no actorJid, no installed authorizer, an
   * authorizer that throws, and any non-`true` return (a truthy non-boolean
   * — e.g. a Promise from a mistakenly-async authorizer — must NOT open the
   * gate). Routing/delegation/fallback never change this result — only the
   * per-turn actor identity does (capability-preserved routing).
   */
  private sensitiveAllowed(session: SessionContext): boolean {
    if (!session.actorJid) return false;
    if (!this.sensitiveAuthorizer) return false;
    try {
      return this.sensitiveAuthorizer(session) === true;
    } catch (err) {
      log.warn({ err }, 'sensitive-tool authorizer threw - denying (fail-closed)');
      return false;
    }
  }

  /** Return names of all tools declared with scope: 'chat'. */
  getChatScopedToolNames(): string[] {
    const names: string[] = [];
    for (const tool of this.tools.values()) {
      if (tool.scope === 'chat') names.push(tool.name);
    }
    return names;
  }

  /** Register a tool. Throws if a tool with the same name is already registered. */
  register(tool: ToolDeclaration): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    log.info({ tool: tool.name }, 'tool registered');
  }

  /**
   * Returns tool listing entries filtered and adapted for the given session.
   *
   * - Global sessions: see all tools. Injected tools get chatJid added to schema.
   * - Chat-scoped sessions: see only 'chat' scope tools. Injected tools have
   *   chatJid omitted (auto-filled at call time).
   */
  listTools(session: SessionContext): Array<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
  }> {
    const result: Array<{ name: string; description: string; inputSchema: JsonSchema }> = [];

    for (const tool of this.tools.values()) {
      // Chat-scoped sessions may not use global-scope tools
      if (session.tier === 'chat-scoped' && tool.scope === 'global') {
        continue;
      }

      result.push({
        name: tool.name,
        description: tool.description,
        inputSchema: buildListSchema(tool, session),
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  /**
   * Call a tool by name with params and session.
   *
   * Scope enforcement:
   * 1. Global-scope tools are rejected in chat-scoped sessions.
   * 2. For injected tools in chat-scoped sessions, deliveryJid is auto-filled
   *    from session and chatJid must NOT be present in params.
   * 3. For injected tools in global sessions, chatJid must be supplied in params.
   *    The resolved conversationKey must match (no cross-conversation calls).
   */
  async call(
    name: string,
    params: Record<string, unknown>,
    session: SessionContext,
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // --- R1 sensitive-tool gate (central, authoritative; in-handler
    // assertAdmin checks remain as defense in depth) ---
    if (tool.sensitive && !this.sensitiveAllowed(session)) {
      // UNIFORM reply for every denial — missing actorJid (wiring fault) and
      // unauthorized actor are indistinguishable to the caller, identical to
      // a nonexistent tool, so call() never becomes an existence oracle for
      // sensitive names. The diagnosis (which actor, why) lives server-side:
      // the specific admin-predicate reason is logged inside the authorizer.
      log.warn(
        { tool: name, tier: session.tier, actorJid: session.actorJid ?? null },
        session.actorJid ? 'sensitive tool denied (unauthorized actor)' : 'sensitive tool denied (missing actorJid - runtime wiring fault)',
      );
      // Preserve the forensic trail the pre-R1 in-handler denial left in the
      // durable ledger (F07): a denied attempt is still an attributable event.
      const denyConvKey = session.conversationKey ?? '';
      if (this.durability && denyConvKey) {
        const denyId = this.durability.recordToolCall(
          denyConvKey,
          name,
          JSON.stringify(params),
          tool.replayPolicy ?? 'unsafe',
        );
        this.durability.markToolExecuting(denyId);
        this.durability.markToolComplete(denyId, 'error: sensitive tool denied (unauthorized or actor-less)');
      }
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // --- Scope enforcement ---
    if (session.tier === 'chat-scoped' && tool.scope === 'global') {
      return {
        content: [{ type: 'text', text: `Tool "${name}" is not available in a chat-scoped session` }],
        isError: true,
      };
    }

    // --- Target injection/validation for injected tools ---
    let effectiveParams = { ...params };

    if (tool.targetMode === 'injected') {
      const supportsAliasTarget = schemaHasProperty(tool, 'to');

      if (session.tier === 'chat-scoped') {
        // Auto-fill deliveryJid from session; chatJid should not come from caller
        if (!session.deliveryJid) {
          return {
            content: [{ type: 'text', text: `Session has no deliveryJid — cannot auto-fill target for tool "${name}"` }],
            isError: true,
          };
        }
        // Remove any caller-supplied chatJid to prevent override
        delete effectiveParams['chatJid'];
        if (supportsAliasTarget) delete effectiveParams['to'];
        effectiveParams['chatJid'] = session.deliveryJid;
      } else {
        // Global session: caller must supply chatJid, or an alias target for
        // tools that explicitly support `to`.
        const callerJid = effectiveParams['chatJid'];
        const hasCallerJid = hasNonEmptyString(callerJid);
        const hasAliasTarget = supportsAliasTarget && hasNonEmptyString(effectiveParams['to']);
        if (!hasCallerJid && !hasAliasTarget) {
          return {
            content: [{
              type: 'text',
              text: supportsAliasTarget
                ? `Tool "${name}" requires chatJid or to parameter in a global session`
                : `Tool "${name}" requires chatJid parameter in a global session`,
            }],
            isError: true,
          };
        }

        // Cross-conversation guard: only enforced when session has a bound conversationKey
        // Alias targets are resolved inside the tool handler, then checked there.
        if (session.conversationKey && hasCallerJid && !hasAliasTarget) {
          let resolved: string;
          try {
            resolved = toConversationKey(callerJid);
          } catch {
            return {
              content: [{ type: 'text', text: `Invalid chatJid "${callerJid}": must be a valid JID` }],
              isError: true,
            };
          }

          if (resolved !== session.conversationKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: `chatJid "${callerJid}" resolves to conversation "${resolved}" which does not match session conversation "${session.conversationKey}"`,
                },
              ],
              isError: true,
            };
          }
        }
      }
    }

    // --- Schema validation ---
    const parsed = tool.schema.safeParse(effectiveParams);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Invalid parameters for tool "${name}": ${parsed.error.message}` }],
        isError: true,
      };
    }

    // --- Invoke handler ---
    const start = Date.now();
    log.debug({ tool: name, tier: session.tier }, 'tool call start');

    const replayPolicy = tool.replayPolicy ?? 'unsafe';
    const conversationKey = session.conversationKey ?? '';
    const durabilityId = this.durability && conversationKey
      ? this.durability.recordToolCall(
          conversationKey,
          name,
          JSON.stringify(effectiveParams),
          replayPolicy,
        )
      : undefined;

    if (durabilityId !== undefined) {
      this.durability!.markToolExecuting(durabilityId);
    }

    try {
      const result = await tool.handler(effectiveParams, session);
      const isError = isToolErrorPayload(result);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      log.info({ tool: name, durationMs: Date.now() - start }, 'tool call complete');
      if (durabilityId !== undefined) {
        this.durability!.markToolComplete(durabilityId, text);
      }
      return {
        content: [{ type: 'text', text }],
        ...(isError ? { isError: true } : {}),
      };
    } catch (err) {
      const message = errorMessage(err);
      log.error({ tool: name, durationMs: Date.now() - start, err }, 'tool handler threw');
      if (durabilityId !== undefined) {
        this.durability!.markToolComplete(durabilityId, `error: ${message}`);
      }
      // Sanitize transport/protocol errors but keep application-level errors readable.
      // Raw stack traces, socket internals, and TLS details must never reach the agent.
      const safeMessage = /ECONNRESET|EPIPE|ENOTCONN|ETIMEDOUT|TLS|certificate|socket hang up/i.test(message)
        ? `Tool "${name}" failed: connection error — try again`
        : `Tool "${name}" failed: ${message}`;
      return {
        content: [{ type: 'text', text: safeMessage }],
        isError: true,
      };
    }
  }
}
