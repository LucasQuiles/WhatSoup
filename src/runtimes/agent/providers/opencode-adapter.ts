// src/runtimes/agent/providers/opencode-adapter.ts
// OpenCode HTTP serve adapter — wraps `opencode serve` persistent HTTP mode.
//
// Unlike Claude/Codex/Gemini which use stdio pipes, OpenCode exposes a REST API:
//   POST /session          — create a session
//   POST /session/:id/message — send a turn, optionally with noReply / model overrides
//   GET  /session          — list sessions (used for health confirmation)
//
// The adapter spawns `opencode serve --hostname 127.0.0.1 --port <port>` as a
// child process and drives it over HTTP.  Sessions survive a server restart
// (stored on disk) so checkpoint/resume is supported via `conversationRef`.

import { spawn, type ChildProcess } from 'node:child_process';

import type {
  ProviderCheckpoint,
  ProviderConfig,
  ProviderDescriptor,
  ProviderSession,
  ProviderSessionOptions,
  ProviderTurnRequest,
} from './types.ts';
import { buildBaseChildEnv } from './child-env.ts';

// ---------------------------------------------------------------------------
// Static descriptor
// ---------------------------------------------------------------------------

export const opencodeDescriptor: ProviderDescriptor = {
  id: 'opencode-cli',
  displayName: 'OpenCode',
  transport: 'http',
  executionMode: 'managed_loop',
  mcpMode: 'none',
  imageSupport: 'none',
  supportsResume: true,
  defaultWatchdog: { softMs: 120_000, warnMs: 300_000, hardMs: 600_000 },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default port for the opencode HTTP server. */
const DEFAULT_PORT = 14096;

/** How long to wait for the server health-check to pass after spawn (ms). */
const SERVER_READY_TIMEOUT_MS = 15_000;

/** Interval between health-check polls (ms). */
const SERVER_POLL_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// Internal types for OpenCode HTTP API
// ---------------------------------------------------------------------------

interface OpenCodeSession {
  id: string;
  title?: string;
}

interface OpenCodeMessagePart {
  type: 'text';
  text: string;
}

interface OpenCodeMessageBody {
  parts: OpenCodeMessagePart[];
  noReply?: boolean;
  model?: { providerID: string; modelID: string };
}

interface OpenCodeMessageResponse {
  info?: {
    role?: string;
    sessionID?: string;
    model?: { providerID: string; modelID: string };
  };
  parts?: OpenCodeMessagePart[];
  // Response shape when noReply is false (assistant reply):
  text?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Environment builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal environment for the opencode server child process.
 * Only the vars opencode actually needs are forwarded.
 */
function buildOpenCodeEnv(): NodeJS.ProcessEnv {
  const env = buildBaseChildEnv();

  // Pass through any OPENCODE_SERVER_PASSWORD the host has set.
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    env.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
  }

  return env;
}

// ---------------------------------------------------------------------------
// OpenCodeAdapter
// ---------------------------------------------------------------------------

export class OpenCodeAdapter implements ProviderSession {
  readonly descriptor = opencodeDescriptor;

  private serverProcess: ChildProcess | null = null;
  private port: number;
  private model: string | null = null;
  private sessionId: string | null = null;
  private opts: ProviderSessionOptions | null = null;
  private active = false;
  private abortController: AbortController | null = null;

  /**
   * @param config - Optional provider config block from the instance's config.json.
   *   Recognises `providerConfig.port` (number) and `providerConfig.model` (string).
   */
  constructor(config?: ProviderConfig['providerConfig']) {
    this.port = typeof config?.port === 'number' ? (config.port as number) : DEFAULT_PORT;
    this.model = typeof config?.model === 'string' ? config.model : null;
  }

  // -- ProviderSession interface ---------------------------------------------

  async initialize(
    opts: ProviderSessionOptions,
    checkpoint?: ProviderCheckpoint,
  ): Promise<void> {
    if (this.active) return;

    this.opts = opts;
    if (opts.model) this.model = opts.model;

    // Spawn `opencode serve` as a background process
    this.serverProcess = spawn(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)],
      {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildOpenCodeEnv(),
      },
    );

    this.serverProcess.on('error', (err) => {
      this.active = false;
      this.serverProcess = null;
      opts.onCrash({ exitCode: null, signal: err.message });
    });

    this.serverProcess.on('exit', (code, signal) => {
      if (!this.active) return; // clean shutdown, ignore
      this.active = false;
      this.serverProcess = null;
      opts.onCrash({ exitCode: code, signal: signal as string | null });
    });

    // Wait for the server to become healthy
    await this.waitForServer();

    // Resume an existing session if a checkpoint carries one; otherwise create new.
    const resumeRef = checkpoint?.conversationRef ?? null;
    if (resumeRef) {
      this.sessionId = resumeRef;
    } else {
      const session = await this.createSession();
      this.sessionId = session.id;
    }

    this.active = true;
    opts.onEvent({ type: 'init', sessionId: this.sessionId });
  }

  async sendTurn(request: ProviderTurnRequest): Promise<void> {
    if (!this.opts || !this.active) {
      throw new Error('OpenCodeAdapter: session not active. Call initialize() first.');
    }
    if (!this.sessionId) {
      throw new Error('OpenCodeAdapter: no session ID — initialize() may not have completed.');
    }

    // Collect text parts
    const text = request.parts
      .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
      .map(p => p.text)
      .join('\n');

    // Build the message body
    const body: OpenCodeMessageBody = {
      parts: [{ type: 'text', text }],
    };

    // Per-turn model override: expect "providerID/modelID" format e.g. "opencode/qwen3.6-plus-free"
    const modelStr = request.model ?? this.model;
    if (modelStr) {
      const slashIdx = modelStr.indexOf('/');
      if (slashIdx > 0) {
        body.model = {
          providerID: modelStr.slice(0, slashIdx),
          modelID: modelStr.slice(slashIdx + 1),
        };
      }
    }

    this.abortController = new AbortController();

    let response: Response;
    try {
      response = await fetch(
        `http://127.0.0.1:${this.port}/session/${this.sessionId}/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.abortController.signal,
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onEvent({ type: 'result', text: `OpenCode fetch error: ${msg}` });
      return;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)');
      this.opts.onEvent({
        type: 'result',
        text: `OpenCode API error ${response.status}: ${errText}`,
      });
      return;
    }

    let data: OpenCodeMessageResponse;
    try {
      data = (await response.json()) as OpenCodeMessageResponse;
    } catch {
      this.opts.onEvent({ type: 'result', text: 'OpenCode: failed to parse response JSON' });
      return;
    }

    // Emit any assistant text found in the response.
    // The API may return text in parts[].text (assistant reply shape) or a top-level text field.
    let assistantText = '';

    if (Array.isArray(data.parts)) {
      for (const part of data.parts) {
        if (part.type === 'text' && part.text) {
          assistantText += part.text;
        }
      }
    } else if (typeof data.text === 'string' && data.text.length > 0) {
      assistantText = data.text;
    }

    if (assistantText.length > 0) {
      this.opts.onEvent({ type: 'assistant_text', text: assistantText });
    }

    if (data.error) {
      this.opts.onEvent({ type: 'result', text: data.error });
      return;
    }

    this.opts.onEvent({ type: 'result', text: null });
  }

  getCheckpoint(): ProviderCheckpoint {
    return {
      providerKind: 'opencode-cli',
      executionMode: 'managed_loop',
      conversationRef: this.sessionId,
      runtimeHandle:
        this.serverProcess?.pid != null
          ? { kind: 'pid', pid: this.serverProcess.pid }
          : { kind: 'none' },
      transcriptLocator: { kind: 'none' },
      providerState: {
        port: this.port,
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
    if (this.serverProcess !== null) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
    this.sessionId = null;
  }

  kill(): void {
    this.abortController?.abort();
    this.active = false;
    if (this.serverProcess !== null) {
      this.serverProcess.kill('SIGKILL');
      this.serverProcess = null;
    }
    this.sessionId = null;
  }

  buildEnv(): NodeJS.ProcessEnv {
    // HTTP adapter — no subprocess to configure, but satisfy the interface.
    return buildOpenCodeEnv();
  }

  // generateMcpConfig is not applicable for this provider (mcpMode: 'none').

  // -- Private helpers -------------------------------------------------------

  /**
   * Poll GET /health until the server responds or the timeout expires.
   */
  private async waitForServer(): Promise<void> {
    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    let lastErr = '';

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) return;
        lastErr = `status ${res.status}`;
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err.message : String(err);
      }

      await new Promise<void>(res => setTimeout(res, SERVER_POLL_INTERVAL_MS));
    }

    throw new Error(
      `OpenCodeAdapter: server on port ${this.port} did not become healthy within ${SERVER_READY_TIMEOUT_MS}ms. Last error: ${lastErr}`,
    );
  }

  /**
   * POST /session to create a new session, returning its descriptor.
   */
  private async createSession(): Promise<OpenCodeSession> {
    const res = await fetch(`http://127.0.0.1:${this.port}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      throw new Error(`OpenCodeAdapter: POST /session failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as OpenCodeSession;
    if (!data.id) {
      throw new Error('OpenCodeAdapter: POST /session returned no session id');
    }

    return data;
  }
}
