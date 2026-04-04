// src/runtimes/agent/providers/anthropic-api.ts
// Anthropic Messages API provider — managed_loop execution mode.
// Uses Anthropic's native Messages API with SSE streaming.
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

export const anthropicApiDescriptor: ProviderDescriptor = {
  id: 'anthropic-api',
  displayName: 'Anthropic API',
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

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface ToolUseAccum {
  id: string;
  name: string;
  inputJson: string;
}

interface CallApiResult {
  text: string;
  toolUses?: ToolUseAccum[];
  inputTokens?: number;
  outputTokens?: number;
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
  private abortController: AbortController | null = null;
  private config: ProviderConfig['providerConfig'];

  /**
   * @param config - Optional provider config block from the instance's config.json.
   *   Allows overriding `model` and `maxTokens` at registration time.
   */
  constructor(config?: ProviderConfig['providerConfig']) {
    this.config = config;
    this.model = config?.model ?? 'claude-sonnet-4-20250514';
  }

  // ── ProviderSession interface ─────────────────────────────────────────────

  async initialize(
    opts: ProviderSessionOptions,
    _checkpoint?: ProviderCheckpoint,
  ): Promise<void> {
    this.opts = opts;
    this.active = true;

    // API key from environment (populated by buildEnv or the host process)
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? '';

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

    // Collect text parts; images would need base64 encoding (future)
    const textParts = request.parts
      .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
      .map(p => p.text);
    const text = textParts.join('\n');

    this.messages.push({ role: 'user', content: text });

    if (this.messages.length > MAX_HISTORY_MESSAGES) {
      this.messages = this.messages.slice(-MAX_HISTORY_MESSAGES);
    }

    let lastInputTokens: number | undefined;
    let lastOutputTokens: number | undefined;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const result = await this.callApi(turnModel);

      lastInputTokens = result.inputTokens;
      lastOutputTokens = result.outputTokens;

      if (!result.toolUses || result.toolUses.length === 0) {
        // Final text response — loop complete
        break;
      }

      // Emit tool_use events and record placeholder results.
      // Real tool execution will be wired via the MCP bridge in B07.
      const toolResultBlocks: AnthropicContentBlock[] = [];

      for (const tu of result.toolUses) {
        let toolInput: Record<string, unknown>;
        try {
          toolInput = JSON.parse(tu.inputJson || '{}') as Record<string, unknown>;
        } catch {
          toolInput = {};
        }

        this.opts.onEvent({
          type: 'tool_use',
          toolName: tu.name,
          toolId: tu.id,
          toolInput,
        });

        // Placeholder tool result — will be replaced by real MCP execution in B07
        const placeholderContent = 'Tool execution not yet wired';

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: placeholderContent,
        });

        this.opts.onEvent({
          type: 'tool_result',
          isError: false,
          toolId: tu.id,
          content: placeholderContent,
        });
      }

      // Anthropic requires tool results in a user turn
      this.messages.push({ role: 'user', content: toolResultBlocks });
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
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async callApi(model: string): Promise<CallApiResult> {
    if (!this.opts) throw new Error('Provider not initialized.');

    this.abortController = new AbortController();

    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(process.env.ANTHROPIC_API_KEY ? { 'x-api-key': process.env.ANTHROPIC_API_KEY } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: (this.config?.maxTokens as number | undefined) ?? 16384,
          system: this.systemPrompt,
          messages: this.messages,
          stream: true,
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
    // Indexed by content block index
    const textBlockAccum: Map<number, string> = new Map();
    const toolUseAccum: Map<number, ToolUseAccum> = new Map();
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

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Malformed SSE chunk — skip
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
                | { input_tokens?: number; output_tokens?: number }
                | undefined;
              if (typeof usage?.input_tokens === 'number') {
                inputTokens = usage.input_tokens;
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
      }
    } finally {
      reader.releaseLock();
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
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tu.inputJson || '{}') as Record<string, unknown>;
      } catch {
        input = {};
      }
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
}
