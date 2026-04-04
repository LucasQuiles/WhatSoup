// src/runtimes/agent/providers/openai-api.ts
// OpenAI-compatible API provider — managed_loop execution mode.
// Works with OpenAI, Ollama, vLLM, Azure OpenAI, LM Studio, and any
// endpoint that implements the OpenAI chat completions SSE streaming API.
//
// NOTE: HTTP providers read API keys from process.env directly in each callApi()
// invocation (not through buildEnv) because they don't spawn subprocesses.
// This ensures key rotations or late-set env vars are always picked up fresh.

import type {
  ProviderCheckpoint,
  ProviderConfig,
  ProviderDescriptor,
  ProviderSession,
  ProviderSessionOptions,
  ProviderTurnRequest,
} from './types.ts';

// ---------------------------------------------------------------------------
// Static descriptor
// ---------------------------------------------------------------------------

export const openaiApiDescriptor: ProviderDescriptor = {
  id: 'openai-api',
  displayName: 'OpenAI API',
  transport: 'http',
  executionMode: 'managed_loop',
  mcpMode: 'none',
  imageSupport: 'base64',
  supportsResume: false,
  defaultWatchdog: { softMs: 120_000, warnMs: 300_000, hardMs: 600_000 },
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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

  /**
   * @param config - Optional provider config block from the instance's config.json.
   *   Allows overriding `baseUrl` and `model` at registration time.
   */
  constructor(config?: ProviderConfig['providerConfig']) {
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config?.model ?? 'gpt-4o';
  }

  // ── ProviderSession interface ─────────────────────────────────────────────

  async initialize(
    opts: ProviderSessionOptions,
    _checkpoint?: ProviderCheckpoint,
  ): Promise<void> {
    this.opts = opts;
    this.active = true;

    // API key from environment (populated by buildEnv or the host process)
    this.apiKey = process.env.OPENAI_API_KEY ?? '';

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

    // Collect text parts; images would need base64 encoding (future)
    const textParts = request.parts
      .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
      .map(p => p.text);
    const text = textParts.join('\n');

    this.messages.push({ role: 'user', content: text });

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

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // Final text response — loop complete
        break;
      }

      // Emit tool_use events and record placeholder results.
      // Real tool execution will be wired via the MCP bridge in B07.
      for (const tc of result.toolCalls) {
        if (!this.active) break;
        this.opts.onEvent({
          type: 'tool_use',
          toolName: tc.function.name,
          toolId: tc.id,
          toolInput: (() => {
            try {
              return JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
            } catch {
              return {};
            }
          })(),
        });

        // Placeholder tool result — will be replaced by real MCP execution in B07
        const placeholderContent = 'Tool execution not yet wired';

        this.messages.push({
          role: 'tool',
          content: placeholderContent,
          tool_call_id: tc.id,
        });

        this.opts.onEvent({
          type: 'tool_result',
          isError: false,
          toolId: tc.id,
          content: placeholderContent,
        });
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
    const env: NodeJS.ProcessEnv = {};
    if (process.env.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    }
    return env;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async callApi(model: string): Promise<CallApiResult> {
    if (!this.opts) throw new Error('Provider not initialized.');

    this.abortController = new AbortController();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.OPENAI_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: this.messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: this.abortController.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onEvent({ type: 'result', text: `Fetch error: ${msg}` });
      return { text: '' };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)');
      this.opts.onEvent({
        type: 'result',
        text: `API error ${response.status}: ${errText}`,
      });
      return { text: '' };
    }

    // ── SSE streaming ────────────────────────────────────────────────────────

    const reader = response.body?.getReader();
    if (!reader) {
      this.opts.onEvent({ type: 'result', text: 'No response body' });
      return { text: '' };
    }

    const decoder = new TextDecoder();
    let sseBuffer = '';
    let fullText = '';
    // Sparse array indexed by tool_call delta index
    const toolCallAccum: ToolCall[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Malformed SSE chunk — skip
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
      }
    } finally {
      reader.releaseLock();
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
}
