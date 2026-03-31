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
} from 'zod';
import { toConversationKey } from '../core/conversation-key.ts';
import { createChildLogger } from '../logger.ts';
import type { DurabilityEngine } from '../core/durability.ts';
import type { ToolDeclaration, ToolCallResult, SessionContext } from './types.ts';

const log = createChildLogger('ToolRegistry');

// ---------------------------------------------------------------------------
// Zod → JSON Schema (minimal, handles the types we use in tool declarations)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: ZodType): JsonSchema {
  if (schema instanceof ZodString) {
    return { type: 'string' };
  }

  if (schema instanceof ZodNumber) {
    return { type: 'number' };
  }

  if (schema instanceof ZodBoolean) {
    return { type: 'boolean' };
  }

  if (schema instanceof ZodOptional) {
    // Unwrap and mark the inner type
    return zodToJsonSchema(schema.unwrap());
  }

  if (schema instanceof ZodArray) {
    return {
      type: 'array',
      items: zodToJsonSchema(schema.element),
    };
  }

  if (schema instanceof ZodEnum) {
    return {
      type: 'string',
      enum: schema.options as string[],
    };
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
    return result;
  }

  // Fallback for unrecognised types
  return {};
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

  if (session.tier === 'chat-scoped') {
    // Strip chatJid — it is auto-filled from session.deliveryJid at call time.
    delete props['chatJid'];
    return {
      ...base,
      properties: props,
      required: existingRequired.filter((k) => k !== 'chatJid'),
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

  /** Attach a DurabilityEngine to record tool calls. */
  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
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

    return result;
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
        effectiveParams['chatJid'] = session.deliveryJid;
      } else {
        // Global session: caller must supply chatJid
        const callerJid = effectiveParams['chatJid'];
        if (!callerJid || typeof callerJid !== 'string') {
          return {
            content: [{ type: 'text', text: `Tool "${name}" requires chatJid parameter in a global session` }],
            isError: true,
          };
        }

        // Cross-conversation guard: only enforced when session has a bound conversationKey
        if (session.conversationKey) {
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
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      log.info({ tool: name, durationMs: Date.now() - start }, 'tool call complete');
      if (durabilityId !== undefined) {
        this.durability!.markToolComplete(durabilityId, text);
      }
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
