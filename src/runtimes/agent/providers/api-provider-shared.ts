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
import { resolveApiKey } from './api-key-resolver.ts';
import { boundedRetryAfterMs } from './rate-limit-retry.ts';
import { providerPreview } from '../provider-preview-sanitizer.ts';

type ProviderLogger = ReturnType<typeof createChildLogger>;

/** Minimal terminal shape both providers' CallApiResult are assignable from. */
interface TerminalApiResult {
  text: string;
  terminalResultText: string;
}

/**
 * Outcome of the shared HTTP error ladder. Either the caller should retry the
 * request after a rate-limit pause (the side-effecting wait + recursion stays
 * in the provider), or it has a terminal user-facing message to surface.
 */
export type SharedApiErrorOutcome =
  | { kind: 'rate-limit-retry'; retryAfterMs: number }
  | { kind: 'terminal'; text: string };

/**
 * Build the `buildEnv()` courtesy environment for an HTTP provider.
 *
 * HTTP providers don't spawn subprocesses, but the ProviderSession interface
 * requires `buildEnv()`. Resolve the provider's API key via the keyring →
 * env precedence chain and expose it under `envVar` ONLY when present, so a
 * missing key yields an empty object (no leaked / placeholder entry).
 */
export function buildApiKeyEnv(envVar: string, opts: { service: string | undefined }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const resolved = resolveApiKey({ service: opts.service, envVar });
  if (resolved) {
    env[envVar] = resolved;
  }
  return env;
}

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

/**
 * Map a thrown `fetch` rejection (connection failure) to the shared terminal
 * result. Identical in both providers: log the error and surface a bounded
 * connection-error message — never the raw exception.
 */
export function connectionErrorResult(err: unknown, model: string, log: ProviderLogger): TerminalApiResult {
  const msg = errorMessage(err);
  log.error({ err: msg, model }, 'fetch error in callApi');
  return { text: '', terminalResultText: '_Connection error - please try again._' };
}

/**
 * Map the SHARED, non-divergent branches of the HTTP error ladder to either a
 * rate-limit retry signal or a terminal user-facing message.
 *
 * Covers ONLY: 400, 429 (+Retry-After), >=500, and the generic else. It does
 * NOT handle 401 — that branch diverges per provider (Anthropic surfaces a
 * dedicated administrator message; OpenAI has no 401 branch and a 401 falls
 * through here to the generic `_Service error (401) ..._`). Callers MUST handle
 * their own 401 (and any surrogate self-heal) BEFORE delegating here.
 *
 * The 429 retry side-effects (awaiting Retry-After + re-issuing the request)
 * stay in the provider; this function only decides whether to retry.
 */
export function mapSharedApiError(
  args: {
    status: number;
    headers: Headers;
    errText: string;
    model: string;
    selfHealAttempt: boolean;
    rateLimitRetryAttempt: boolean;
  },
  log: ProviderLogger,
): SharedApiErrorOutcome {
  const { status, headers, errText, model, selfHealAttempt, rateLimitRetryAttempt } = args;

  if (status === 400) {
    log.error({ status: 400, errPreview: providerPreview(errText, 500), model, selfHealAttempt }, 'API 400 error');
    return {
      kind: 'terminal',
      text: '_There was an issue with my conversation data. Please try again or send /new to start fresh._',
    };
  }

  if (status === 429) {
    const retryAfterMs = boundedRetryAfterMs(headers);
    if (!rateLimitRetryAttempt && retryAfterMs !== null) {
      log.warn({ status: 429, model, retryAfterMs }, 'API rate limited — retrying after Retry-After');
      return { kind: 'rate-limit-retry', retryAfterMs };
    }
    log.warn({ status: 429, model }, 'API rate limited');
    return { kind: 'terminal', text: '_Rate limited - please wait a moment and try again._' };
  }

  if (status >= 500) {
    log.error({ status, model }, 'API server error');
    return { kind: 'terminal', text: '_Service temporarily unavailable - please try again in a moment._' };
  }

  log.error({ status, errPreview: providerPreview(errText, 300), model }, 'API error');
  return { kind: 'terminal', text: `_Service error (${status}) - please try again._` };
}
