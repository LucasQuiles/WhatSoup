// src/runtimes/agent/providers/api-provider-shared.ts
// Small, pure free functions shared by the HTTP API providers
// (`anthropic-api.ts` and `openai-api.ts`).
//
// SCOPE (BEAD-020): this module captures ONLY the safe, byte-identical
// orchestration scaffolding that both providers duplicated — tool-input
// parse/guard logic and its `ParsedToolInput` contract. It is deliberately
// NOT a base class and NOT a single mega-HOF. Per-provider concerns
// (sendTurn tool-result shaping, SSE parsing + token accounting, the 401
// branch + Anthropic system-prompt sanitize, URL/headers/body construction,
// and message seeding) stay in their respective files.

import { createChildLogger } from '../../../logger.ts';
import { errorMessage } from '../../../lib/error-message.ts';

type ProviderLogger = ReturnType<typeof createChildLogger>;

/**
 * Outcome of parsing a provider's raw tool-call arguments.
 * `ok: false` carries a user/model-facing `content` string explaining why the
 * tool was NOT executed — callers feed it back as an error tool_result.
 */
export type ParsedToolInput =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; content: string };

/** Per-call context for {@link parseProviderToolInput}. */
export interface ToolInputParseContext {
  /** Provider-assigned tool-call id (for logging). */
  toolId: string;
  /** Tool name (used in logs and the failure message). */
  toolName: string;
  /** Model name (for logging). */
  model: string;
  /** Log message for a JSON parse failure (provider-specific phrasing). */
  malformedLabel: string;
  /** Log message for a non-object / array payload (provider-specific phrasing). */
  nonObjectLabel: string;
}

/**
 * Parse and guard a provider's raw tool-call argument JSON.
 *
 * Shared by both HTTP providers. The provider supplies the raw JSON string
 * (Anthropic: `toolUse.inputJson`; OpenAI: `toolCall.function.arguments`) plus
 * its accessor-derived ids and provider-specific log labels. Behaviour is
 * identical to the previous per-provider implementations:
 *   - malformed JSON  → blocked, `ok: false` with the malformed-arguments text
 *   - non-object/array → blocked, `ok: false` with the must-be-object text
 *   - valid object     → `ok: true`
 */
export function parseProviderToolInput(
  rawJson: string,
  ctx: ToolInputParseContext,
  log: ProviderLogger,
): ParsedToolInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson || '{}');
  } catch (err) {
    const message = errorMessage(err);
    log.warn({
      err: message,
      model: ctx.model,
      toolId: ctx.toolId,
      toolName: ctx.toolName,
      argumentLength: rawJson.length,
    }, ctx.malformedLabel);
    return {
      ok: false,
      content: `Tool "${ctx.toolName}" failed: malformed provider tool arguments; the tool was not executed.`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn({
      model: ctx.model,
      toolId: ctx.toolId,
      toolName: ctx.toolName,
      argumentType: Array.isArray(parsed) ? 'array' : typeof parsed,
    }, ctx.nonObjectLabel);
    return {
      ok: false,
      content: `Tool "${ctx.toolName}" failed: provider tool arguments must be a JSON object; the tool was not executed.`,
    };
  }

  return { ok: true, input: parsed as Record<string, unknown> };
}
