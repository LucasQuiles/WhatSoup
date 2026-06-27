// src/runtimes/agent/providers/openai-api.ts
// OpenAI-compatible API provider — managed_loop execution mode.
// Works with OpenAI, Ollama, vLLM, Azure OpenAI, LM Studio, and any
// endpoint that implements the OpenAI chat completions SSE streaming API.
//
// NOTE: API keys resolve via `resolveApiKey()` (`./api-key-resolver.ts`) at
// request time — HTTP providers don't spawn subprocesses, so buildEnv() is
// only used as a courtesy.
// Precedence: `apiKeyService` keyring lookup (when configured) →
// `process.env.OPENAI_API_KEY` env fallback.
// The auth header is computed per-request so late-set keyring entries / key
// rotations are picked up without a process restart.

import type {
  ProviderCheckpoint,
  ProviderConfig,
  ProviderDescriptor,
  ProviderSession,
  ProviderSessionOptions,
  ProviderTurnRequest,
} from './types.ts';
import { convertMcpToolsToOpenAI, executeBridgeTool } from './mcp-bridge.ts';
import { resolveApiKey } from './api-key-resolver.ts';
import { turnPartsToOpenAIContent } from './media-bridge.ts';
import { readSseDataLines } from './sse.ts';
import { stripLoneSurrogates, sanitizeMessageHistory, isSurrogateError } from '../../../core/sanitize-surrogates.ts';
import { createChildLogger } from '../../../logger.ts';
import { boundedRetryAfterMs, waitForRateLimitRetry } from './rate-limit-retry.ts';
import { providerPreview } from '../provider-preview-sanitizer.ts';
import { errorMessage } from '../../../lib/error-message.ts';
import { parseProviderToolInput, buildApiKeyEnv, type ParsedToolInput } from './api-provider-shared.ts';

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

interface CallApiResult {
  text: string;
  toolCalls?: ToolCall[];
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
    this.opts = opts;
    this.active = true;

    // API key precedence: apiKeyService keyring → OPENAI_API_KEY env.
    // Re-resolved per request inside callApi() so late-set keys are picked up.
    this.apiKey = resolveApiKey({ service: this.apiKeyService, envVar: 'OPENAI_API_KEY' });

    // Per-turn model override takes lowest precedence; opts.model wins over
    // the constructor default when explicitly set.
    if (opts.model) {
      this.model = opts.model;
    }

    // System prompt as the first conversation message
    this.messages = [{ role: 'system', content: opts.systemPrompt }];

    opts.onEvent({ type: 'init', sessionId: `openai-api-${Date.now()}` });
  }

  async sendTurn(request: ProviderTurnRequest): Promise<void> {
    if (!this.opts) throw new Error('Provider not initialized. Call initialize() first.');

    // Per-turn model override (e.g. model-switch mid-conversation)
    const turnModel = request.model ?? this.model;

    const hasRichParts = request.parts.some((part) => part.kind !== 'text');
    const userContent = hasRichParts
      ? turnPartsToOpenAIContent(request.parts)
      : stripLoneSurrogates(
          request.parts
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

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // Final text response — loop complete
        break;
      }

      // Emit tool_use events and feed executed tool results back into the loop.
      for (const tc of result.toolCalls) {
        if (!this.active) break;
        const parsedToolInput = this.parseToolInput(tc, turnModel);
        const toolInput = parsedToolInput.ok ? parsedToolInput.input : {};

        this.opts.onEvent({
          type: 'tool_use',
          toolName: tc.function.name,
          toolId: tc.id,
          toolInput,
        });

        const toolResult = parsedToolInput.ok
          ? await executeBridgeTool(this.opts?.mcpBridge, tc.function.name, toolInput)
          : { content: parsedToolInput.content, isError: true };

        this.messages.push({
          role: 'tool',
          content: toolResult.content,
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
        log.warn({ model: turnModel, toolCallCount: result.toolCalls.length }, 'managed tool loop exhausted');
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
  }

  kill(): void {
    this.abortController?.abort();
    this.active = false;
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
    const mcpTools = this.opts.mcpBridge?.listTools() ?? [];

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
      const msg = errorMessage(err);
      log.error({ err: msg, model }, 'fetch error in callApi');
      return { text: '', terminalResultText: '_Connection error - please try again._' };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)');

      // Self-heal: surrogate corruption
      if (response.status === 400 && isSurrogateError(errText) && !selfHealAttempt) {
        log.warn({ model, errPreview: providerPreview(errText, 200) }, 'surrogate corruption detected — sanitizing and retrying');
        sanitizeMessageHistory(this.messages as Array<{ role: string; content: unknown }>);
        return this.callApi(model, true);
      }

      // User-friendly error — never show raw JSON error bodies
      let friendlyMsg: string;
      if (response.status === 400) {
        friendlyMsg = '_There was an issue with my conversation data. Please try again or send /new to start fresh._';
        log.error({ status: 400, errPreview: providerPreview(errText, 500), model, selfHealAttempt }, 'API 400 error');
      } else if (response.status === 429) {
        const retryAfterMs = boundedRetryAfterMs(response.headers);
        if (!rateLimitRetryAttempt && retryAfterMs !== null) {
          log.warn({ status: 429, model, retryAfterMs }, 'API rate limited — retrying after Retry-After');
          await waitForRateLimitRetry(retryAfterMs, this.abortController.signal);
          return this.callApi(model, selfHealAttempt, true);
        }
        friendlyMsg = '_Rate limited - please wait a moment and try again._';
      } else if (response.status >= 500) {
        friendlyMsg = '_Service temporarily unavailable - please try again in a moment._';
      } else {
        friendlyMsg = `_Service error (${response.status}) - please try again._`;
      }

      return { text: '', terminalResultText: friendlyMsg };
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
        log.warn({ err, dataPreview: providerPreview(data, 200), model }, 'malformed SSE chunk from OpenAI-compatible API');
        continue;
      }

      const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;

      if (delta) {
        // ── Text content ─────────────────────────────────────────────
        if (typeof delta['content'] === 'string' && delta['content'].length > 0) {
          fullText += delta['content'];
          this.opts.onEvent({ type: 'assistant_text', text: delta['content'] });
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
    this.messages.push(assistantMsg);

    return {
      text: fullText,
      toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      inputTokens,
      outputTokens,
    };
  }

  private parseToolInput(toolCall: ToolCall, model: string): ParsedToolInput {
    return parseProviderToolInput(toolCall.function.arguments, {
      toolId: toolCall.id,
      toolName: toolCall.function.name,
      model,
      malformedLabel: 'malformed OpenAI-compatible tool arguments; tool call blocked',
      nonObjectLabel: 'non-object OpenAI-compatible tool arguments; tool call blocked',
    }, log);
  }
}
