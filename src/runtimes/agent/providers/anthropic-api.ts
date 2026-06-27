// src/runtimes/agent/providers/anthropic-api.ts
// Anthropic Messages API provider — managed_loop execution mode.
// Uses Anthropic's native Messages API with SSE streaming.
//
// NOTE: API keys resolve via `resolveApiKey()` (`./api-key-resolver.ts`) at
// request time — HTTP providers don't spawn subprocesses, so buildEnv() is
// only used as a courtesy.
// Precedence: `apiKeyService` keyring lookup (when configured) →
// `process.env.ANTHROPIC_API_KEY` env fallback.
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
import { convertMcpToolsToAnthropic, executeBridgeTool } from './mcp-bridge.ts';
import { resolveApiKey } from './api-key-resolver.ts';
import { turnPartsToAnthropicContent } from './media-bridge.ts';
import { readSseDataLines } from './sse.ts';
import { stripLoneSurrogates, sanitizeMessageHistory, isSurrogateError } from '../../../core/sanitize-surrogates.ts';
import { createChildLogger } from '../../../logger.ts';
import { boundedRetryAfterMs, waitForRateLimitRetry } from './rate-limit-retry.ts';
import { providerPreview } from '../provider-preview-sanitizer.ts';
import { errorMessage } from '../../../lib/error-message.ts';
import { parseProviderToolInput, type ParsedToolInput } from './api-provider-shared.ts';

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


interface CallApiResult {
  text: string;
  toolUses?: ToolUseAccum[];
  inputTokens?: number;
  outputTokens?: number;
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
    this.opts = opts;
    this.active = true;

    // API key precedence: apiKeyService keyring → ANTHROPIC_API_KEY env.
    // Re-resolved per request inside callApi() so late-set keys are picked up.
    this.apiKey = resolveApiKey({ service: this.config?.apiKeyService, envVar: 'ANTHROPIC_API_KEY' });

    // Per-turn model override takes lowest precedence; opts.model wins over
    // the constructor default when explicitly set.
    if (opts.model) {
      this.model = opts.model;
    }

    // System prompt stored separately — Anthropic uses a top-level field
    this.systemPrompt = opts.systemPrompt;
    this.messages = [];

    opts.onEvent({ type: 'init', sessionId: `anthropic-api-${Date.now()}` });
  }

  async sendTurn(request: ProviderTurnRequest): Promise<void> {
    if (!this.opts) throw new Error('Provider not initialized. Call initialize() first.');

    // Per-turn model override (e.g. model-switch mid-conversation)
    const turnModel = request.model ?? this.model;

    const userContent = turnPartsToAnthropicContent(request.parts).map((block) => (
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

      if (!result.toolUses || result.toolUses.length === 0) {
        // Final text response — loop complete
        break;
      }

      // Emit tool_use events and feed executed tool results back into the loop.
      const toolResultBlocks: AnthropicContentBlock[] = [];

      for (const tu of result.toolUses) {
        if (!this.active) break;
        // Parity with openai-api parseToolInput: malformed or non-object
        // provider input must NOT execute the tool — it feeds back to the
        // model as an error tool_result instead. Substituting {} executed
        // real side-effecting tools with empty arguments.
        const parsedToolInput = tu.parsed ?? this.parseToolInput(tu, turnModel);
        const toolInput = parsedToolInput.ok ? parsedToolInput.input : {};

        this.opts.onEvent({
          type: 'tool_use',
          toolName: tu.name,
          toolId: tu.id,
          toolInput,
        });

        const toolResult = parsedToolInput.ok
          ? await executeBridgeTool(this.opts?.mcpBridge, tu.name, toolInput)
          : { content: parsedToolInput.content, isError: true };

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: stripLoneSurrogates(toolResult.content),
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
        log.warn({ model: turnModel, toolUseCount: result.toolUses.length }, 'managed tool loop exhausted');
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
  }

  kill(): void {
    this.abortController?.abort();
    this.active = false;
  }

  buildEnv(): NodeJS.ProcessEnv {
    // HTTP providers don't spawn subprocesses, but the interface requires this.
    const env: NodeJS.ProcessEnv = {};
    const resolved = resolveApiKey({ service: this.config?.apiKeyService, envVar: 'ANTHROPIC_API_KEY' });
    if (resolved) {
      env.ANTHROPIC_API_KEY = resolved;
    }
    return env;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async callApi(model: string, selfHealAttempt = false, rateLimitRetryAttempt = false): Promise<CallApiResult> {
    if (!this.opts) throw new Error('Provider not initialized.');

    this.abortController = new AbortController();
    const mcpTools = this.opts.mcpBridge?.listTools() ?? [];

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
      const msg = errorMessage(err);
      log.error({ err: msg, model }, 'fetch error in callApi');
      return { text: '', terminalResultText: '_Connection error - please try again._' };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)');

      // ── Self-heal: surrogate corruption in message history ──────────────
      // If the API rejects the payload due to lone surrogates and we haven't
      // tried recovery yet, sanitize the entire history and retry once.
      if (response.status === 400 && isSurrogateError(errText) && !selfHealAttempt) {
        log.warn(
          { model, errPreview: providerPreview(errText, 200), messageCount: this.messages.length },
          'surrogate corruption detected — self-healing conversation history',
        );
        // Deep-sanitize the stored messages (mutates in place for future turns too)
        const repaired = sanitizeMessageHistory(this.messages as Array<{ role: string; content: unknown }>);
        log.info({ repairedFields: repaired }, 'self-heal complete — retrying API call');
        // Retry once with the sanitized history (typing indicator is already active)
        return this.callApi(model, true);
      }

      // ── User-friendly error messages ───────────────────────────────────
      // Never expose raw API error JSON to the user.
      let friendlyMsg: string;
      if (response.status === 400) {
        friendlyMsg = '_There was an issue with my conversation data. Please try again or send /new to start fresh._';
        log.error({ status: 400, errPreview: providerPreview(errText, 500), model, selfHealAttempt }, 'API 400 error (post self-heal)');
      } else if (response.status === 429) {
        const retryAfterMs = boundedRetryAfterMs(response.headers);
        if (!rateLimitRetryAttempt && retryAfterMs !== null) {
          log.warn({ status: 429, model, retryAfterMs }, 'API rate limited — retrying after Retry-After');
          await waitForRateLimitRetry(retryAfterMs, this.abortController.signal);
          return this.callApi(model, selfHealAttempt, true);
        }
        friendlyMsg = '_Rate limited - please wait a moment and try again._';
        log.warn({ status: 429, model }, 'API rate limited');
      } else if (response.status === 401) {
        friendlyMsg = '_Authentication error - please contact the administrator._';
        log.error({ status: 401, model }, 'API auth error');
      } else if (response.status >= 500) {
        friendlyMsg = '_Service temporarily unavailable - please try again in a moment._';
        log.error({ status: response.status, model }, 'API server error');
      } else {
        friendlyMsg = `_Service error (${response.status}) - please try again._`;
        log.error({ status: response.status, errPreview: providerPreview(errText, 300), model }, 'API error');
      }

      return { text: '', terminalResultText: friendlyMsg };
    }

    // ── SSE streaming ────────────────────────────────────────────────────────

    const body = response.body;
    if (!body) {
      return { text: '', terminalResultText: 'No response body' };
    }

    let fullText = '';
    // Indexed by content block index
    const textBlockAccum: Map<number, string> = new Map();
    const toolUseAccum: Map<number, ToolUseAccum> = new Map();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const data of readSseDataLines(body)) {
      if (data === '[DONE]') continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch (err) {
        // Malformed SSE chunk - skip, but preserve observability.
        log.warn({ err, dataPreview: providerPreview(data, 200), model }, 'malformed SSE chunk from Anthropic API');
        continue;
      }

      const eventType = event['type'] as string | undefined;

      switch (eventType) {
        case 'content_block_start': {
          const index = event['index'] as number;
          const block = event['content_block'] as Record<string, unknown> | undefined;
          if (!block) break;

          if (block['type'] === 'text') {
            textBlockAccum.set(index, '');
          } else if (block['type'] === 'tool_use') {
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
              const existing = textBlockAccum.get(index) ?? '';
              textBlockAccum.set(index, existing + chunk);
              fullText += chunk;
              this.opts.onEvent({ type: 'assistant_text', text: chunk });
            }
          } else if (deltaType === 'input_json_delta') {
            const partialJson = (delta['partial_json'] as string) ?? '';
            const existing = toolUseAccum.get(index);
            if (existing) {
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
          }
          if (typeof usage?.output_tokens === 'number') {
            outputTokens = usage.output_tokens;
          }
          break;
        }

        // content_block_stop and message_stop require no action
        default:
          break;
      }
    }

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

    // Record assistant turn in conversation history
    if (assistantContent.length > 0) {
      this.messages.push({ role: 'assistant', content: assistantContent });
    } else if (fullText.length > 0) {
      this.messages.push({ role: 'assistant', content: fullText });
    }

    return {
      text: fullText,
      toolUses: completedToolUses.length > 0 ? completedToolUses : undefined,
      inputTokens,
      outputTokens,
    };
  }

  private parseToolInput(toolUse: ToolUseAccum, model: string): ParsedToolInput {
    return parseProviderToolInput(toolUse.inputJson, {
      toolId: toolUse.id,
      toolName: toolUse.name,
      model,
      malformedLabel: 'malformed Anthropic tool input; tool call blocked',
      nonObjectLabel: 'non-object Anthropic tool input; tool call blocked',
    }, log);
  }

}
