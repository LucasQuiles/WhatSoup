// src/runtimes/agent/providers/claude.ts
// Claude Code CLI provider — implements ProviderSession for the `claude` subprocess.

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import type {
  ProviderCheckpoint,
  ProviderDescriptor,
  ProviderSession,
  ProviderSessionOptions,
  ProviderTurnRequest,
} from './types.ts';
import { parseEvent } from '../stream-parser.ts';

// ---------------------------------------------------------------------------
// Static descriptor
// ---------------------------------------------------------------------------

export const claudeDescriptor: ProviderDescriptor = {
  id: 'claude-cli',
  displayName: 'Claude Code',
  transport: 'subprocess',
  executionMode: 'persistent_session',
  mcpMode: 'config_file',
  imageSupport: 'file_path',
  supportsResume: true,
  defaultWatchdog: { softMs: 600_000, warnMs: 1_200_000, hardMs: 1_800_000 },
};

// ---------------------------------------------------------------------------
// Stdin write timeout
// ---------------------------------------------------------------------------

const STDIN_WRITE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Environment builder
// ---------------------------------------------------------------------------

/**
 * Build an explicit environment for Claude Code child processes.
 *
 * Security rationale: spawn() with no `env` option inherits process.env in full.
 * For a multi-provider system this is a security hole — Codex would receive
 * Anthropic's key, Gemini would receive OpenAI's key, etc. By constructing an
 * explicit allowlist we ensure each subprocess only gets the credentials it needs.
 */
// NOTE: This is intentionally duplicated from session.ts until SessionManager
// is wired through ClaudeProvider. Once session.ts delegates to ClaudeProvider,
// remove the copy in session.ts and keep only this one.
function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // System essentials
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    // Node.js
    NODE_PATH: process.env.NODE_PATH,
    // XDG dirs (Linux)
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    // Sudo support
    SUDO_ASKPASS: process.env.SUDO_ASKPASS,
  };

  // OPENAI_API_KEY: passed because Claude Code may use it for its own features.
  // ANTHROPIC_API_KEY is deliberately excluded — Claude uses subscription auth.
  if (process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  // Excluded: ANTHROPIC_API_KEY (subscription auth), PINECONE_API_KEY (parent MCP only),
  // WHATSOUP_HEALTH_TOKEN (parent-only auth token)

  // Strip undefined values (env vars not set in the parent process)
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  ) as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// ClaudeProvider
// ---------------------------------------------------------------------------

export class ClaudeProvider implements ProviderSession {
  readonly descriptor = claudeDescriptor;

  private child: ChildProcess | null = null;
  private opts: ProviderSessionOptions | null = null;
  private sessionId: string | null = null;
  private stdoutBuffer = '';
  private active = false;

  // ── ProviderSession interface ─────────────────────────────────────────────

  async initialize(
    opts: ProviderSessionOptions,
    checkpoint?: ProviderCheckpoint,
  ): Promise<void> {
    if (this.active && this.child !== null) {
      return;
    }

    this.opts = opts;
    const resumeId = checkpoint?.conversationRef ?? undefined;

    const cwd = opts.cwd;
    const systemPrompt = opts.systemPrompt;

    const args: string[] = [
      '-p',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--system-prompt', systemPrompt,
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.pluginDirs ?? []).flatMap(dir => ['--plugin-dir', dir]),
      ...(resumeId ? ['--resume', resumeId] : []),
    ];

    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(),
    });

    this.child = child;
    this.active = true;
    this.stdoutBuffer = '';
    this.sessionId = null;

    // Handle spawn errors (e.g. claude binary not in PATH)
    child.on('error', (_err) => {
      this.active = false;
      this.child = null;
      this.sessionId = null;
      opts.onCrash({ exitCode: null, signal: null });
    });

    // Pipe stdout through line parser
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      const lines = this.stdoutBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      this.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseEvent(line);
        if (event === null) continue;

        // Capture session ID from init event
        if (event.type === 'init') {
          this.sessionId = event.sessionId;
        }

        opts.onEvent(event);
      }
    });

    // Handle unexpected exit
    child.on('exit', (code, signal) => {
      // Ignore exit events from superseded child processes
      if (this.child !== child) return;

      if (!this.active) {
        // Clean shutdown — already handled
        return;
      }

      // Drain any buffered stdout before crash processing
      if (this.stdoutBuffer.trim() !== '') {
        for (const line of this.stdoutBuffer.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            const event = parseEvent(trimmed);
            if (event) opts.onEvent(event);
          }
        }
        this.stdoutBuffer = '';
      }

      this.active = false;
      this.child = null;

      opts.onCrash({ exitCode: code, signal: signal as string | null });
    });
  }

  async sendTurn(request: ProviderTurnRequest): Promise<void> {
    if (this.child === null || !this.active) {
      throw new Error('No active session. Call initialize() first.');
    }

    // Build the text content from parts
    const textParts = request.parts
      .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
      .map(p => p.text);
    const text = textParts.join('\n');

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });

    const stdin = this.child.stdin;
    if (!stdin) throw new Error('Child process stdin is not available');

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        new Promise<void>((res, rej) => {
          stdin.write(payload + '\n', 'utf8', (err) => {
            if (err) rej(err);
            else res();
          });
        }),
        new Promise<never>((_, rej) => {
          timeoutHandle = setTimeout(
            () => rej(new Error('STDIN_WRITE_TIMEOUT: agent not reading input')),
            STDIN_WRITE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }

  getCheckpoint(): ProviderCheckpoint {
    return {
      providerKind: 'claude-cli',
      executionMode: 'persistent_session',
      conversationRef: this.sessionId,
      runtimeHandle: this.child?.pid != null ? { kind: 'pid', pid: this.child.pid } : { kind: 'none' },
      transcriptLocator: this.sessionId
        ? { kind: 'file', path: this.deriveTranscriptPath() }
        : { kind: 'none' },
      providerState: {},
    };
  }

  isActive(): boolean {
    return this.active;
  }

  async shutdown(_reason: 'suspend' | 'end'): Promise<void> {
    if (this.child !== null) {
      this.active = false; // Suppress crash notification for clean shutdown
      this.child.kill('SIGTERM');
      this.child = null;
      this.sessionId = null;
    }
  }

  kill(): void {
    if (this.child !== null) {
      this.active = false;
      this.child.kill('SIGKILL');
      this.child = null;
      this.sessionId = null;
    }
  }

  buildEnv(): NodeJS.ProcessEnv {
    return buildChildEnv();
  }

  generateMcpConfig(socketPath: string): Record<string, unknown> | null {
    // Resolve the whatsoup MCP proxy script relative to this file's location
    const mcpServerScript = resolve(
      new URL('.', import.meta.url).pathname,
      '../../../../deploy/mcp/whatsoup-proxy.ts',
    );

    return {
      mcpServers: {
        whatsoup: {
          command: 'node',
          args: ['--experimental-strip-types', mcpServerScript],
          env: { WHATSOUP_SOCKET: socketPath },
        },
      },
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private deriveTranscriptPath(): string {
    const username = userInfo().username;
    return join(
      homedir(),
      '.claude',
      'projects',
      `-home-${username}`,
      `${this.sessionId}.jsonl`,
    );
  }
}
