// src/runtimes/agent/providers/anthropic-api.ts
// Anthropic Messages API provider — managed_loop execution mode.
// Uses Anthropic's native Messages API with SSE streaming.
//
// NOTE: API keys resolve via `resolveApiKey()` (`../../../lib/api-key-resolver.ts`)
// at request time — HTTP providers don't spawn subprocesses, so buildEnv() is
// only used as a courtesy.
// Precedence: `apiKeyService` keyring lookup (when configured) →
// `process.env.ANTHROPIC_API_KEY` env fallback.
// The auth header is computed per-request so late-set keyring entries / key
// rotations are picked up without a process restart.

import { randomUUID } from 'node:crypto';

import type {
  ProviderCheckpoint,
  ProviderConfig,
  ProviderDescriptor,
  ProviderSession,
  ProviderSessionOptions,
  ProviderTurnRequest,
} from './types.ts';
import { convertMcpToolsToAnthropic, executeBridgeTool, snapshotProviderMcpTools } from './mcp-bridge.ts';
import { resolveApiKey } from '../../../lib/api-key-resolver.ts';
import { turnPartsToAnthropicContent } from './media-bridge.ts';
import { readSseDataFrames } from './sse.ts';
import { stripLoneSurrogates, sanitizeMessageHistory, isSurrogateError } from '../../../core/sanitize-surrogates.ts';
import { createChildLogger } from '../../../logger.ts';
import { boundedRetryAfterMs, waitForRateLimitRetry } from './rate-limit-retry.ts';
import { providerPreview } from '../provider-preview-sanitizer.ts';
import {
  parseProviderToolInput,
  buildApiKeyEnv,
  mapSharedApiError,
  connectionErrorResult,
  type ParsedToolInput,
} from './api-provider-shared.ts';
import {
  ProviderDataBoundaryError,
  snapshotProviderDataBoundary,
} from '../../../core/provider-data-boundary.ts';
import { exposeProviderTurnParts } from '../../../core/provider-data-boundary-turn.ts';
import { mapRestrictedProviderApiError } from '../../../core/provider-data-boundary-http.ts';
import { createRestrictedProviderResponseBudget } from '../../../core/provider-data-boundary-response.ts';

const log = createChildLogger('anthropic-api-provider');

// ---------------------------------------------------------------------------
// Static descriptor
// ---------------------------------------------------------------------------

export const anthropicApiDescriptor: ProviderDescriptor = {
  id: 'anthropic-api',
  displayName: 'Anthropic API',
  transport: 'http',
  executionMode: 'managed_loop',
  mcpMode: 'native_bridge',
  imageSupport: 'base64',
  supportsResume: false,
  defaultWatchdog: { softMs: 120_000, warnMs: 300_000, hardMs: 600_000 },
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface ToolUseAccum {
  id: string;
  name: string;
  inputJson: string;
  /** Single parse outcome — set in callApi after SSE accumulation completes,
   *  consumed by sendTurn (defensive re-parse fallback if ever unset). */
  parsed?: ParsedToolInput;
}

interface PreparedToolUse {
  toolUse: ToolUseAccum;
  parsed: ParsedToolInput;
  toolInput: Record<string, unknown>;
}


interface CallApiResult {
  text: string;
  toolUses?: ToolUseAccum[];
  preparedToolUses?: PreparedToolUse[];
  stagedAssistantMessage?: AnthropicMessage;
  localText?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** See stream-parser.ts's 'result' event field of the same name (#1774). */
  cacheReadTokens?: number;
  terminalResultText?: string;
}

const MAX_TOOL_ITERATIONS = 20;
const MAX_HISTORY_MESSAGES = 100;

// ---------------------------------------------------------------------------
// AnthropicApiProvider
// ---------------------------------------------------------------------------

export class AnthropicApiProvider implements ProviderSession {
  readonly descriptor = anthropicApiDescriptor;

  private opts: ProviderSessionOptions | null = null;
  private messages: AnthropicMessage[] = [];
  private systemPrompt: string = '';
  private active = false;
  private model: string;
  private apiKey: string = '';
  private baseUrl: string;
  private abortController: AbortController | null = null;
  private config: ProviderConfig['providerConfig'];
  private providerTools = snapshotProviderMcpTools([]);

  private get dataBoundary() {
    return this.opts?.providerDataBoundary;
  }

  private get boundaryEnforced(): boolean {
    return this.opts?.routePolicy?.dataPolicy === 'restricted'
      && this.opts.providerBoundaryMode === 'enforce'
      && this.dataBoundary !== undefined;
  }

  private get boundaryRestricted(): boolean {
    return this.opts?.routePolicy?.dataPolicy === 'restricted' && this.dataBoundary !== undefined;
  }

  /**
   * @param config - Optional provider config block from the instance's config.json.
   *   Allows overriding `model` and `maxTokens` at registration time.
   */
  constructor(config?: ProviderConfig['providerConfig']) {
    this.config = config;
    this.model = config?.model ?? 'claude-sonnet-4-6';
    this.baseUrl = (config?.baseUrl as string | undefined) ?? 'https://api.anthropic.com/v1';
  }

  // ── ProviderSession interface ─────────────────────────────────────────────

  async initialize(
    opts: ProviderSessionOptions,
    _checkpoint?: ProviderCheckpoint,
  ): Promise<void> {
    if (
      opts.routePolicy?.dataPolicy === 'restricted'
      && opts.providerBoundaryMode === 'enforce'
      && opts.providerDataBoundary === undefined
    ) {
      throw new Error('Restricted managed API route requires a provider data boundary');
    }
    if (opts.providerDataBoundary && (
      opts.providerDataBoundary.binding.provider !== 'anthropic-api'
      || opts.providerDataBoundary.binding.model !== opts.model
      || opts.providerDataBoundary.binding.dataPolicy !== opts.routePolicy?.dataPolicy
      || opts.providerDataBoundary.binding.policyVersion !== opts.routePolicy?.policyVersion
      || opts.providerDataBoundary.binding.providerSessionId !== opts.providerSessionId
      || opts.providerDataBoundary.mode !== opts.providerBoundaryMode
    )) {
      opts.providerDataBoundary.retire();
      throw new Error('Managed API provider data boundary binding mismatch');
    }
    try {
      const routePolicy = opts.routePolicy ? Object.freeze({ ...opts.routePolicy }) : undefined;
      const providerDataBoundary = opts.providerDataBoundary
        ? snapshotProviderDataBoundary(opts.providerDataBoundary)
        : undefined;
      this.opts = Object.freeze({ ...opts, routePolicy, providerDataBoundary });
      this.active = true;
      this.providerTools = snapshotProviderMcpTools(opts.mcpBridge?.listTools() ?? []);

      // API key precedence: apiKeyService keyring → ANTHROPIC_API_KEY env.
      // Re-resolved per request inside callApi() so late-set keys are picked up.
      this.apiKey = resolveApiKey({ service: this.config?.apiKeyService, envVar: 'ANTHROPIC_API_KEY' });

      // Per-turn model override takes lowest precedence; opts.model wins over
      // the constructor default when explicitly set.
      if (opts.model) {
        this.model = opts.model;
      }

      // System prompt stored separately — Anthropic uses a top-level field
      this.systemPrompt = providerDataBoundary?.exposeText(opts.systemPrompt, { surface: 'prompt' })
        ?? opts.systemPrompt;
      this.messages = [];

      opts.onEvent({ type: 'init', sessionId: opts.providerSessionId ?? `anthropic-api-${randomUUID()}` });
    } catch (error) {
      opts.providerDataBoundary?.retire();
      this.opts = null;
      this.active = false;
      throw error;
    }
  }

  async sendTurn(request: ProviderTurnRequest): Promise<void> {
    if (!this.opts) throw new Error('Provider not initialized. Call initialize() first.');

    // Per-turn model override (e.g. model-switch mid-conversation)
    const turnModel = request.model ?? this.model;
    this.dataBoundary?.assertModel(turnModel);

    const providerParts = exposeProviderTurnParts(this.dataBoundary, request.parts);
    const userContent = turnPartsToAnthropicContent(providerParts).map((block) => (
      block.type === 'text'
        ? { ...block, text: stripLoneSurrogates(block.text) }
        : block
    ));

    this.messages.push({ role: 'user', content: userContent });

    if (this.messages.length > MAX_HISTORY_MESSAGES) {
      this.messages = this.messages.slice(-MAX_HISTORY_MESSAGES);
    }

    let lastInputTokens: number | undefined;
    let lastOutputTokens: number | undefined;
    let lastCacheReadTokens: number | undefined;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const historyLengthBeforeCall = this.messages.length;
      const result = await this.callApi(turnModel);

      // A later tool-loop iteration that errors out (connection drop, rate
      // limit exhausted, no response body) reports no usage at all — that
      // must not erase the real usage an earlier iteration in this same
      // turn already recorded (#1775 Mechanism B: this clobber silently
      // zeroed a served turn's token accounting).
      lastInputTokens = result.inputTokens ?? lastInputTokens;
      lastOutputTokens = result.outputTokens ?? lastOutputTokens;
      lastCacheReadTokens = result.cacheReadTokens ?? lastCacheReadTokens;

      if (result.terminalResultText !== undefined) {
        this.opts.onEvent({
          type: 'result',
          text: result.terminalResultText,
          inputTokens: lastInputTokens,
          outputTokens: lastOutputTokens,
          cacheReadTokens: lastCacheReadTokens,
        });
        return;
      }

      if (result.stagedAssistantMessage) {
        this.messages.push(result.stagedAssistantMessage);
        if (result.localText !== undefined) {
          this.opts.onEvent({ type: 'assistant_text', text: result.localText });
        }
      }

      if (!result.toolUses || result.toolUses.length === 0) {
        // Final text response — loop complete
        break;
      }

      // Emit tool_use events and feed executed tool results back into the loop.
      const toolResultBlocks: AnthropicContentBlock[] = [];
      let preparedUses = result.preparedToolUses;
      if (!preparedUses) {
        const advertisedTools = this.providerTools;
        try {
          const parsedUses = result.toolUses.map((toolUse) => ({
            toolUse,
            parsed: toolUse.parsed ?? this.parseToolInput(toolUse, turnModel),
          }));
          preparedUses = parsedUses.map(({ toolUse, parsed }) => ({
            toolUse,
            parsed,
            toolInput: parsed.ok
              ? this.dataBoundary?.rehydrateToolInput(toolUse.name, parsed.input, advertisedTools)
                ?? parsed.input
              : {},
          }));
        } catch (error) {
          this.messages.length = historyLengthBeforeCall;
          throw error;
        }
      }

      for (const { toolUse: tu, parsed: parsedToolInput, toolInput } of preparedUses) {
        if (!this.active) break;
        // Parity with openai-api parseToolInput: malformed or non-object
        // provider input must NOT execute the tool — it feeds back to the
        // model as an error tool_result instead. Substituting {} executed
        // real side-effecting tools with empty arguments.
        this.opts.onEvent({
          type: 'tool_use',
          toolName: tu.name,
          toolId: tu.id,
          toolInput,
        });

        const toolResult = parsedToolInput.ok
          ? await executeBridgeTool(this.opts?.mcpBridge, tu.name, toolInput)
          : { content: parsedToolInput.content, isError: true };

        const providerToolContent = this.dataBoundary?.exposeToolResult(tu.name, toolResult.content)
          ?? toolResult.content;
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: stripLoneSurrogates(providerToolContent),
          ...(toolResult.isError ? { is_error: true } : {}),
        });

        this.opts.onEvent({
          type: 'tool_result',
          isError: toolResult.isError,
          toolId: tu.id,
          content: toolResult.content,
        });
      }

      // Anthropic requires tool results in a user turn
      this.messages.push({ role: 'user', content: toolResultBlocks });

      // Killed mid-loop: do not re-enter callApi. The history now has
      // tool_use blocks without matching tool_result entries (the inner
      // loop broke early), which the API rejects with a hard 400 — and the
      // session is dead anyway.
      if (!this.active) break;

      if (i === MAX_TOOL_ITERATIONS - 1) {
        log.warn(
          this.boundaryRestricted
            ? { code: 'provider_boundary_tool_loop_exhausted', toolUseCount: result.toolUses.length }
            : { model: turnModel, toolUseCount: result.toolUses.length },
          'managed tool loop exhausted',
        );
        this.opts.onEvent({
          type: 'result',
          text: '_Tool loop limit reached - please try again or send /new._',
          inputTokens: lastInputTokens,
          outputTokens: lastOutputTokens,
          cacheReadTokens: lastCacheReadTokens,
        });
        return;
      }
    }

    this.opts.onEvent({
      type: 'result',
      text: null,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens,
      cacheReadTokens: lastCacheReadTokens,
    });
  }

  getCheckpoint(): ProviderCheckpoint {
    return {
      providerKind: 'anthropic-api',
      executionMode: 'managed_loop',
      conversationRef: null,
      runtimeHandle: { kind: 'none' },
      transcriptLocator: { kind: 'none' },
      providerState: {
        messageCount: this.messages.length,
        model: this.model,
      },
    };
  }

  isActive(): boolean {
    return this.active;
  }

  async shutdown(_reason: 'suspend' | 'end'): Promise<void> {
    this.abortController?.abort();
    this.active = false;
    this.dataBoundary?.retire();
  }

  kill(): void {
    this.abortController?.abort();
    this.active = false;
    this.dataBoundary?.retire();
  }

  buildEnv(): NodeJS.ProcessEnv {
    // HTTP providers don't spawn subprocesses, but the interface requires this.
    return buildApiKeyEnv('ANTHROPIC_API_KEY', { service: this.config?.apiKeyService });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async callApi(model: string, selfHealAttempt = false, rateLimitRetryAttempt = false): Promise<CallApiResult> {
    if (!this.opts) throw new Error('Provider not initialized.');

    this.abortController = new AbortController();
    const mcpTools = this.providerTools;

    // Defense layer: sanitize the system prompt and message history before
    // serialization to prevent lone surrogates from producing invalid JSON.
    // This is a hot path — stripLoneSurrogates fast-paths strings with no surrogates.
    const sanitizedSystem = stripLoneSurrogates(this.systemPrompt);
    sanitizeMessageHistory(this.messages as Array<{ role: string; content: unknown }>);

    let response: Response;
    try {
      // Resolve each request so key rotation / late-set keyring entries are picked up.
      const authKey = resolveApiKey({ service: this.config?.apiKeyService, envVar: 'ANTHROPIC_API_KEY' });
      response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(authKey ? { 'x-api-key': authKey } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: (this.config?.maxTokens as number | undefined) ?? 16384,
          system: sanitizedSystem,
          messages: this.messages,
          ...(mcpTools.length > 0
            ? { tools: convertMcpToolsToAnthropic(mcpTools) }
            : {}),
          stream: true,
        }),
        signal: this.abortController.signal,
      });
    } catch (err: unknown) {
      if (this.boundaryRestricted) {
        log.error({ code: 'provider_boundary_connection_error' }, 'fetch error in restricted callApi');
        return { text: '', terminalResultText: '_Connection error - please try again._' };
      }
      return connectionErrorResult(err, model, log);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)');

      // ── Self-heal: surrogate corruption in message history ──────────────
      // If the API rejects the payload due to lone surrogates and we haven't
      // tried recovery yet, sanitize the entire history and retry once.
      if (response.status === 400 && isSurrogateError(errText) && !selfHealAttempt) {
        if (this.boundaryRestricted) {
          log.warn({ code: 'provider_boundary_surrogate_retry', status: 400 }, 'restricted provider surrogate retry');
        } else {
          log.warn(
            { model, errPreview: providerPreview(errText, 200), messageCount: this.messages.length },
            'surrogate corruption detected — self-healing conversation history',
          );
        }
        // Deep-sanitize the stored messages (mutates in place for future turns too)
        const repaired = sanitizeMessageHistory(this.messages as Array<{ role: string; content: unknown }>);
        log.info({ repairedFields: repaired }, 'self-heal complete — retrying API call');
        // Retry once with the sanitized history (typing indicator is already active)
        return this.callApi(model, true);
      }

      // ── User-friendly error messages ───────────────────────────────────
      // Never expose raw API error JSON to the user.
      //
      // 401 is Anthropic-specific (a dedicated administrator message) and MUST
      // be handled before the shared ladder, which deliberately omits 401.
      if (response.status === 401) {
        log.error(
          this.boundaryRestricted ? { code: 'provider_boundary_auth_error', status: 401 } : { status: 401, model },
          'API auth error',
        );
        return { text: '', terminalResultText: '_Authentication error - please contact the administrator._' };
      }

      const outcome = this.boundaryRestricted
        ? mapRestrictedProviderApiError({
            status: response.status,
            retryAfterMs: response.status === 429 ? boundedRetryAfterMs(response.headers) : null,
            rateLimitRetryAttempt,
          })
        : mapSharedApiError(
            { status: response.status, headers: response.headers, errText, model, selfHealAttempt, rateLimitRetryAttempt },
            log,
          );
      if (this.boundaryRestricted) {
        log.warn(
          { code: 'provider_boundary_http_error', status: response.status },
          'restricted provider HTTP error',
        );
      }
      if (outcome.kind === 'rate-limit-retry') {
        await waitForRateLimitRetry(outcome.retryAfterMs, this.abortController.signal);
        return this.callApi(model, selfHealAttempt, true);
      }

      return { text: '', terminalResultText: outcome.text };
    }

    // ── SSE streaming ────────────────────────────────────────────────────────

    const body = response.body;
    if (!body) {
      return { text: '', terminalResultText: 'No response body' };
    }

    let fullText = '';
    // Indexed by content block index
    const toolUseAccum: Map<number, ToolUseAccum> = new Map();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let sawTerminal = false;
    const responseBudget = this.boundaryRestricted
      ? createRestrictedProviderResponseBudget({
          enforce: this.boundaryEnforced,
          onFailure: (code) => this.dataBoundary!.observeProviderResponseFailure(code),
        })
      : undefined;

    for await (const { data, rawData } of readSseDataFrames(body)) {
      responseBudget?.observeData(rawData);
      if (sawTerminal && this.boundaryRestricted) {
        responseBudget!.observeInvalid();
      }
      if (data === '[DONE]') {
        responseBudget?.observeInvalid();
        continue;
      }

      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (
          this.boundaryRestricted
          && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        ) {
          throw new Error('non-object SSE event');
        }
        event = parsed as Record<string, unknown>;
      } catch (err) {
        // Malformed SSE chunk - skip, but preserve observability.
        if (this.boundaryRestricted) {
          log.warn({ code: 'provider_boundary_malformed_sse' }, 'malformed SSE chunk from restricted Anthropic API');
        } else {
          log.warn({ err, dataPreview: providerPreview(data, 200), model }, 'malformed SSE chunk from Anthropic API');
        }
        responseBudget?.observeInvalid();
        continue;
      }

      const eventType = event['type'] as string | undefined;

      switch (eventType) {
        case 'content_block_start': {
          const index = event['index'] as number;
          const block = event['content_block'] as Record<string, unknown> | undefined;
          if (!block) break;

          if (block['type'] === 'tool_use') {
            responseBudget?.observeToolCall(index);
            toolUseAccum.set(index, {
              id: (block['id'] as string) ?? '',
              name: (block['name'] as string) ?? '',
              inputJson: '',
            });
          }
          break;
        }

        case 'content_block_delta': {
          const index = event['index'] as number;
          const delta = event['delta'] as Record<string, unknown> | undefined;
          if (!delta) break;

          const deltaType = delta['type'] as string | undefined;

          if (deltaType === 'text_delta') {
            const chunk = (delta['text'] as string) ?? '';
            if (chunk.length > 0) {
              responseBudget?.observeText(chunk);
              fullText += chunk;
              if (!this.boundaryRestricted) {
                this.opts.onEvent({ type: 'assistant_text', text: chunk });
              }
            }
          } else if (deltaType === 'input_json_delta') {
            const partialJson = (delta['partial_json'] as string) ?? '';
            const existing = toolUseAccum.get(index);
            if (existing) {
              responseBudget?.observeToolArguments(partialJson);
              existing.inputJson += partialJson;
            }
          }
          break;
        }

        case 'message_delta': {
          const usage = event['usage'] as { output_tokens?: number } | undefined;
          if (typeof usage?.output_tokens === 'number') {
            outputTokens = usage.output_tokens;
          }
          break;
        }

        case 'message_start': {
          const message = event['message'] as Record<string, unknown> | undefined;
          const usage = message?.['usage'] as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              }
            | undefined;
          if (typeof usage?.input_tokens === 'number') {
            const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
            const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
            inputTokens = usage.input_tokens + cacheCreation + cacheRead;
            cacheReadTokens = cacheRead;
          }
          if (typeof usage?.output_tokens === 'number') {
            outputTokens = usage.output_tokens;
          }
          break;
        }

        case 'message_stop':
          sawTerminal = true;
          break;

        // content_block_stop requires no action
        default:
          break;
      }
    }
    responseBudget?.assertTerminal(sawTerminal);

    // Collect completed tool uses
    const completedToolUses = Array.from(toolUseAccum.values()).filter(
      tu => tu.id.length > 0 && tu.name.length > 0,
    );

    // Build assistant message content for conversation history
    const assistantContent: AnthropicContentBlock[] = [];

    if (fullText.length > 0) {
      assistantContent.push({ type: 'text', text: fullText });
    }

    for (const tu of completedToolUses) {
      // Single parse for both the history block and the execution gate.
      // Anthropic requires tool_use.input to be an object, so a malformed
      // payload is forced to {} in HISTORY — but tu.parsed carries the
      // failure to sendTurn, which blocks execution and feeds the error
      // back as a tool_result instead.
      tu.parsed = this.parseToolInput(tu, model);
      const input = tu.parsed.ok ? tu.parsed.input : {};
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input });
    }

    const assistantMessage = assistantContent.length > 0
      ? { role: 'assistant' as const, content: assistantContent }
      : fullText.length > 0
        ? { role: 'assistant' as const, content: fullText }
        : undefined;
    if (!this.boundaryRestricted) {
      if (assistantMessage) this.messages.push(assistantMessage);
      return {
        text: fullText,
        toolUses: completedToolUses.length > 0 ? completedToolUses : undefined,
        inputTokens,
        outputTokens,
        cacheReadTokens,
      };
    }

    const localText = fullText.length > 0
      ? this.dataBoundary!.rehydrateProviderText(fullText, { surface: 'provider_output' })
      : undefined;
    const parsedUses = completedToolUses.map((toolUse) => ({
      toolUse,
      parsed: toolUse.parsed ?? this.parseToolInput(toolUse, model),
    }));
    if (this.boundaryEnforced && parsedUses.some(({ parsed }) => !parsed.ok)) {
      throw new ProviderDataBoundaryError('invalid_tool_input');
    }
    const preparedToolUses = parsedUses.map(({ toolUse, parsed }) => ({
      toolUse,
      parsed,
      toolInput: parsed.ok
        ? this.dataBoundary!.rehydrateToolInput(toolUse.name, parsed.input, this.providerTools)
        : {},
    }));

    return {
      text: fullText,
      toolUses: completedToolUses.length > 0 ? completedToolUses : undefined,
      preparedToolUses: preparedToolUses.length > 0 ? preparedToolUses : undefined,
      ...(assistantMessage === undefined ? {} : { stagedAssistantMessage: assistantMessage }),
      ...(localText === undefined ? {} : { localText }),
      inputTokens,
      outputTokens,
      cacheReadTokens,
    };
  }

  private parseToolInput(toolUse: ToolUseAccum, model: string): ParsedToolInput {
    if (this.boundaryRestricted) {
      const rawJson = toolUse.inputJson || '{}';
      let inspected = false;
      try {
        inspected = this.dataBoundary!.inspectToolJson(rawJson);
      } catch {
        return {
          ok: false,
          content: 'Tool call failed: restricted provider tool arguments were rejected; the tool was not executed.',
        };
      }
      try {
        const parsed = JSON.parse(rawJson) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('non-object');
        }
        if (this.boundaryEnforced && !inspected) {
          throw new Error('restricted inspection rejected input');
        }
        return { ok: true, input: parsed as Record<string, unknown> };
      } catch {
        log.warn({ code: 'provider_boundary_tool_input_rejected' }, 'restricted provider tool input rejected');
        return {
          ok: false,
          content: 'Tool call failed: restricted provider tool arguments were rejected; the tool was not executed.',
        };
      }
    }
    return parseProviderToolInput(toolUse.inputJson, {
      toolId: toolUse.id,
      toolName: toolUse.name,
      model,
      malformedLabel: 'malformed Anthropic tool input; tool call blocked',
      nonObjectLabel: 'non-object Anthropic tool input; tool call blocked',
    }, log);
  }

}
