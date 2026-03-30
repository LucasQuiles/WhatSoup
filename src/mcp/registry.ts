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
 * Build a JSON Schema for tools/list output. For global-session injected tools,
 * `chatJid` is added as a required string property. For chat-scoped sessions it
 * is omitted (the registry will auto-fill it from the session).
 */
function buildListSchema(
  tool: ToolDeclaration,
  session: SessionContext,
): JsonSchema {
  const base = zodToJsonSchema(tool.schema);

  if (tool.targetMode !== 'injected' || session.tier !== 'global') {
    return base;
  }

  // Inject chatJid as a required property into the schema advertised to global
  // callers.
  const props: Record<string, JsonSchema> =
    (base.properties as Record<string, JsonSchema>) ?? {};
  const existingRequired: string[] = (base.required as string[]) ?? [];

  return {
    ...base,
    properties: {
      chatJid: { type: 'string' },
      ...props,
    },
    required: ['chatJid', ...existingRequired],
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDeclaration>();

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
    try {
      const result = await tool.handler(effectiveParams, session);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      log.info({ tool: name, durationMs: Date.now() - start }, 'tool call complete');
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, durationMs: Date.now() - start, err }, 'tool handler threw');
      return {
        content: [{ type: 'text', text: `Tool "${name}" failed: ${message}` }],
        isError: true,
      };
    }
  }
}
