// src/runtimes/agent/providers/openai-api.ts
// OpenAI-compatible API provider — managed_loop execution mode.
// Works with OpenAI, Ollama, vLLM, Azure OpenAI, LM Studio, and any
// endpoint that implements the OpenAI chat completions SSE streaming API.
//
// NOTE: API keys resolve via `resolveApiKey()` (`../../../lib/api-key-resolver.ts`)
// at request time — HTTP providers don't spawn subprocesses, so buildEnv() is
// only used as a courtesy.
// Precedence: `apiKeyService` keyring lookup (when configured) →
// `process.env.OPENAI_API_KEY` env fallback.
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
import { convertMcpToolsToOpenAI, executeBridgeTool, snapshotProviderMcpTools } from './mcp-bridge.ts';
import { resolveApiKey } from '../../../lib/api-key-resolver.ts';
import { turnPartsToOpenAIContent } from './media-bridge.ts';
import { readSseDataLines } from './sse.ts';
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

const log = createChildLogger('openai-api-provider');

// ---------------------------------------------------------------------------
// Static descriptor
// ---------------------------------------------------------------------------

export const openaiApiDescriptor: ProviderDescriptor = {
  id: 'openai-api',
  displayName: 'OpenAI API',
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

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface PreparedToolCall {
  toolCall: ToolCall;
  parsed: ParsedToolInput;
  toolInput: Record<string, unknown>;
}

interface CallApiResult {
  text: string;
  toolCalls?: ToolCall[];
  preparedToolCalls?: PreparedToolCall[];
  stagedAssistantMessage?: ChatMessage;
  localText?: string;
  inputTokens?: number;
  outputTokens?: number;
  terminalResultText?: string;
}

const MAX_TOOL_ITERATIONS = 20;
const MAX_HISTORY_MESSAGES = 100;

// ---------------------------------------------------------------------------
// OpenAIApiProvider
// ---------------------------------------------------------------------------

export class OpenAIApiProvider implements ProviderSession {
  readonly descriptor = openaiApiDescriptor;

  private opts: ProviderSessionOptions | null = null;
  private messages: ChatMessage[] = [];
  private active = false;
  private baseUrl: string;
  private model: string;
  private apiKey: string = '';
  private abortController: AbortController | null = null;
  private apiKeyService: string | undefined;
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
   *   Allows overriding `baseUrl`, `model`, and `apiKeyService` at registration time.
   */
  constructor(config?: ProviderConfig['providerConfig']) {
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config?.model ?? 'gpt-5.4';
    this.apiKeyService = config?.apiKeyService;
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
      opts.providerDataBoundary.binding.provider !== 'openai-api'
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

      // API key precedence: apiKeyService keyring → OPENAI_API_KEY env.
      // Re-resolved per request inside callApi() so late-set keys are picked up.
      this.apiKey = resolveApiKey({ service: this.apiKeyService, envVar: 'OPENAI_API_KEY' });

      // Per-turn model override takes lowest precedence; opts.model wins over
      // the constructor default when explicitly set.
      if (opts.model) {
        this.model = opts.model;
      }

      // System prompt as the first conversation message
      const systemPrompt = providerDataBoundary?.exposeText(opts.systemPrompt, { surface: 'prompt' })
        ?? opts.systemPrompt;
      this.messages = [{ role: 'system', content: systemPrompt }];

      opts.onEvent({ type: 'init', sessionId: opts.providerSessionId ?? `openai-api-${randomUUID()}` });
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
    const hasRichParts = providerParts.some((part) => part.kind !== 'text');
    const userContent = hasRichParts
      ? turnPartsToOpenAIContent(providerParts)
      : stripLoneSurrogates(
          providerParts
            .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
            .map(p => p.text)
            .join('\n'),
        );

    this.messages.push({ role: 'user', content: userContent });

    if (this.messages.length > MAX_HISTORY_MESSAGES) {
      const system = this.messages[0]; // preserve system prompt
      this.messages = [system, ...this.messages.slice(-(MAX_HISTORY_MESSAGES - 1))];
    }

    let lastInputTokens: number | undefined;
    let lastOutputTokens: number | undefined;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const historyLengthBeforeCall = this.messages.length;
      const result = await this.callApi(turnModel);

      lastInputTokens = result.inputTokens;
      lastOutputTokens = result.outputTokens;

      if (result.terminalResultText !== undefined) {
        this.opts.onEvent({
          type: 'result',
          text: result.terminalResultText,
          inputTokens: lastInputTokens,
          outputTokens: lastOutputTokens,
        });
        return;
      }

      if (result.stagedAssistantMessage) {
        this.messages.push(result.stagedAssistantMessage);
        if (result.localText !== undefined) {
          this.opts.onEvent({ type: 'assistant_text', text: result.localText });
        }
      }

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // Final text response — loop complete
        break;
      }

      // Emit tool_use events and feed executed tool results back into the loop.
      let preparedCalls = result.preparedToolCalls;
      if (!preparedCalls) {
        const advertisedTools = this.providerTools;
        try {
          const parsedCalls = result.toolCalls.map((toolCall) => ({
            toolCall,
            parsed: this.parseToolInput(toolCall, turnModel),
          }));
          preparedCalls = parsedCalls.map(({ toolCall, parsed }) => ({
            toolCall,
            parsed,
            toolInput: parsed.ok
              ? this.dataBoundary?.rehydrateToolInput(toolCall.function.name, parsed.input, advertisedTools)
                ?? parsed.input
              : {},
          }));
        } catch (error) {
          this.messages.length = historyLengthBeforeCall;
          throw error;
        }
      }
      for (const { toolCall: tc, parsed: parsedToolInput, toolInput } of preparedCalls) {
        if (!this.active) break;

        this.opts.onEvent({
          type: 'tool_use',
          toolName: tc.function.name,
          toolId: tc.id,
          toolInput,
        });

        const toolResult = parsedToolInput.ok
          ? await executeBridgeTool(this.opts?.mcpBridge, tc.function.name, toolInput)
          : { content: parsedToolInput.content, isError: true };

        const providerToolContent = this.dataBoundary?.exposeToolResult(tc.function.name, toolResult.content)
          ?? toolResult.content;
        this.messages.push({
          role: 'tool',
          content: providerToolContent,
          tool_call_id: tc.id,
        });

        this.opts.onEvent({
          type: 'tool_result',
          isError: toolResult.isError,
          toolId: tc.id,
          content: toolResult.content,
        });
      }

      // Killed mid-loop: do not re-enter callApi. The history now has
      // tool_calls without matching tool messages (the inner loop broke
      // early) and the session is dead anyway.
      if (!this.active) break;

      if (i === MAX_TOOL_ITERATIONS - 1) {
        log.warn(
          this.boundaryRestricted
            ? { code: 'provider_boundary_tool_loop_exhausted', toolCallCount: result.toolCalls.length }
            : { model: turnModel, toolCallCount: result.toolCalls.length },
          'managed tool loop exhausted',
        );
        this.opts.onEvent({
          type: 'result',
          text: '_Tool loop limit reached - please try again or send /new._',
          inputTokens: lastInputTokens,
          outputTokens: lastOutputTokens,
        });
        return;
      }
    }

    this.opts.onEvent({
      type: 'result',
      text: null,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens,
    });
  }

  getCheckpoint(): ProviderCheckpoint {
    return {
      providerKind: 'openai-api',
      executionMode: 'managed_loop',
      conversationRef: null,
      runtimeHandle: { kind: 'none' },
      transcriptLocator: { kind: 'none' },
      providerState: {
        messageCount: this.messages.length,
        model: this.model,
        baseUrl: this.baseUrl,
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
    // Return only what this provider actually needs.
    return buildApiKeyEnv('OPENAI_API_KEY', { service: this.apiKeyService });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async callApi(model: string, selfHealAttempt = false, rateLimitRetryAttempt = false): Promise<CallApiResult> {
    if (!this.opts) throw new Error('Provider not initialized.');

    this.abortController = new AbortController();
    const mcpTools = this.providerTools;

    // Defense layer: sanitize message history before serialization
    sanitizeMessageHistory(this.messages as Array<{ role: string; content: unknown }>);

    let response: Response;
    try {
      // Resolve each request so key rotation / late-set keyring entries are picked up.
      const authKey = resolveApiKey({ service: this.apiKeyService, envVar: 'OPENAI_API_KEY' });
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: this.messages,
          ...(mcpTools.length > 0
            ? { tools: convertMcpToolsToOpenAI(mcpTools) }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
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

      // Self-heal: surrogate corruption
      if (response.status === 400 && isSurrogateError(errText) && !selfHealAttempt) {
        if (this.boundaryRestricted) {
          log.warn({ code: 'provider_boundary_surrogate_retry', status: 400 }, 'restricted provider surrogate retry');
        } else {
          log.warn({ model, errPreview: providerPreview(errText, 200) }, 'surrogate corruption detected — sanitizing and retrying');
        }
        sanitizeMessageHistory(this.messages as Array<{ role: string; content: unknown }>);
        return this.callApi(model, true);
      }

      // User-friendly error — never show raw JSON error bodies.
      // OpenAI has NO dedicated 401 branch: a 401 falls through the shared
      // ladder to the generic `_Service error (401) ..._` message.
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
    // Sparse array indexed by tool_call delta index
    const toolCallAccum: ToolCall[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const data of readSseDataLines(body)) {
      if (data === '[DONE]') continue;

      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch (err) {
        // Malformed SSE chunk - skip, but preserve observability.
        if (this.boundaryRestricted) {
          log.warn({ code: 'provider_boundary_malformed_sse' }, 'malformed SSE chunk from restricted OpenAI-compatible API');
        } else {
          log.warn({ err, dataPreview: providerPreview(data, 200), model }, 'malformed SSE chunk from OpenAI-compatible API');
        }
        continue;
      }

      const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;

      if (delta) {
        // ── Text content ─────────────────────────────────────────────
        if (typeof delta['content'] === 'string' && delta['content'].length > 0) {
          fullText += delta['content'];
          if (!this.boundaryRestricted) {
            this.opts.onEvent({ type: 'assistant_text', text: delta['content'] });
          }
        }

        // ── Tool call deltas ──────────────────────────────────────────
        const deltaToolCalls = delta['tool_calls'] as
          | Array<{
              index: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>
          | undefined;

        if (deltaToolCalls) {
          for (const dtc of deltaToolCalls) {
            const idx = dtc.index;
            if (!toolCallAccum[idx]) {
              toolCallAccum[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (dtc.id) toolCallAccum[idx].id = dtc.id;
            if (dtc.function?.name) toolCallAccum[idx].function.name += dtc.function.name;
            if (dtc.function?.arguments) toolCallAccum[idx].function.arguments += dtc.function.arguments;
          }
        }
      }

      // ── Usage (may appear in any chunk, typically the last) ───────────
      const usage = chunk['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
      }
    }

    // Filter out any sparse-array holes and incomplete tool calls
    const completedToolCalls = toolCallAccum.filter(
      (tc): tc is ToolCall => tc !== undefined && tc.id.length > 0 && tc.function.name.length > 0,
    );

    // Record assistant turn in conversation history
    const assistantMsg: ChatMessage = { role: 'assistant', content: fullText || null };
    if (completedToolCalls.length > 0) {
      assistantMsg.tool_calls = completedToolCalls;
    }
    if (!this.boundaryRestricted) {
      this.messages.push(assistantMsg);
      return {
        text: fullText,
        toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
        inputTokens,
        outputTokens,
      };
    }

    const localText = fullText.length > 0
      ? this.dataBoundary!.rehydrateProviderText(fullText, { surface: 'provider_output' })
      : undefined;
    const parsedCalls = completedToolCalls.map((toolCall) => ({
      toolCall,
      parsed: this.parseToolInput(toolCall, model),
    }));
    if (this.boundaryEnforced && parsedCalls.some(({ parsed }) => !parsed.ok)) {
      throw new ProviderDataBoundaryError('invalid_tool_input');
    }
    const preparedToolCalls = parsedCalls.map(({ toolCall, parsed }) => ({
      toolCall,
      parsed,
      toolInput: parsed.ok
        ? this.dataBoundary!.rehydrateToolInput(toolCall.function.name, parsed.input, this.providerTools)
        : {},
    }));

    return {
      text: fullText,
      toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      preparedToolCalls: preparedToolCalls.length > 0 ? preparedToolCalls : undefined,
      stagedAssistantMessage: assistantMsg,
      ...(localText === undefined ? {} : { localText }),
      inputTokens,
      outputTokens,
    };
  }

  private parseToolInput(toolCall: ToolCall, model: string): ParsedToolInput {
    if (this.boundaryRestricted) {
      const rawJson = toolCall.function.arguments || '{}';
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
    return parseProviderToolInput(toolCall.function.arguments, {
      toolId: toolCall.id,
      toolName: toolCall.function.name,
      model,
      malformedLabel: 'malformed OpenAI-compatible tool arguments; tool call blocked',
      nonObjectLabel: 'non-object OpenAI-compatible tool arguments; tool call blocked',
    }, log);
  }
}
