// src/runtimes/agent/session.ts
// SessionManager owns the Claude Code child process lifecycle.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../core/database.ts';
import type { Messenger } from '../../core/types.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
import { createSession, incrementMessageCount, updateSessionId, updateSessionStatus, updateTranscriptPath } from './session-db.ts';
import { parseEvent } from './stream-parser.ts';
import type { AgentEvent } from './stream-parser.ts';
import { parseCodexEvent } from './providers/codex-parser.ts';
import { parseGeminiAcpEvent, buildInitializeRequest, buildSessionNewRequest, buildSessionPromptRequest } from './providers/gemini-acp-parser.ts';
import { parseOpenCodeEvent, resetParserState as resetOpenCodeParserState } from './providers/opencode-parser.ts';
import { buildBaseChildEnv } from './providers/child-env.ts';

const log = createChildLogger('session-manager');

const STDIN_WRITE_TIMEOUT_MS = 30_000;
/** @deprecated Use WATCHDOG_SOFT_MS / WATCHDOG_HARD_MS instead. Kept for test backward-compat. */
export const TURN_WATCHDOG_MS = 600_000;

// ─── 3-tier watchdog ────────────────────────────────────────────────────────
// Soft probes notify the user; hard kill terminates the process.
// ALL tiers reset on any agent activity (tool_use, tool_result, assistant_text).
export const WATCHDOG_SOFT_MS  = 600_000;   // 10 min — first soft probe
export const WATCHDOG_WARN_MS  = 1_200_000; // 20 min — second soft probe
export const WATCHDOG_HARD_MS  = 1_800_000; // 30 min — SIGKILL

export interface SessionCrashInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The Claude session ID at the time of crash — useful for attempting --resume recovery. */
  sessionId: string | null;
  /** The agent_sessions DB row ID — useful for resume with existing row. */
  dbRowId: number | null;
}

export interface SessionManagerOptions {
  db: Database;
  messenger: Messenger;
  chatJid: string;
  onEvent: (event: AgentEvent) => void;
  instanceName?: string;
  onResumeFailed?: () => void;
  onCrash?: (info: SessionCrashInfo) => void;
  notifyUser?: (msg: string) => void;
  cwd?: string;
  instructionsPath?: string;
  model?: string;
  pluginDirs?: string[];
  provider?: string;
  providerConfig?: Record<string, unknown>;
}

/**
 * Build an explicit environment for Claude Code child processes.
 *
 * Security rationale: spawn() with no `env` option inherits process.env in full.
 * For a multi-provider system this is a security hole — Codex would receive
 * Anthropic's key, Gemini would receive OpenAI's key, etc. By constructing an
 * explicit allowlist we ensure each subprocess only gets the credentials it needs.
 *
 * Extend this function when adding new providers: each provider should only receive
 * its own credentials plus the system essentials below.
 */
function buildChildEnv(provider: string = 'claude-cli'): NodeJS.ProcessEnv {
  const env = buildBaseChildEnv();

  // Provider-specific credentials — each provider only receives the keys it needs.
  switch (provider) {
    case 'codex-cli':
      if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      break;
    case 'gemini-cli':
      if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (process.env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      break;
    case 'opencode-cli':
      // OpenCode reads from its own config or standard API keys
      if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      break;
    case 'claude-cli':
    default:
      // OPENAI_API_KEY: passed because Claude Code may use it for its own features.
      // ANTHROPIC_API_KEY is deliberately excluded — Claude uses subscription auth.
      if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      break;
  }

  // Excluded (all providers): PINECONE_API_KEY (parent MCP only),
  // WHATSOUP_HEALTH_TOKEN (parent-only auth token)

  return env;
}

export class SessionManager {
  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly chatJid: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly instanceName: string;
  private configuredCwd: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly model: string | undefined;
  private readonly pluginDirs: string[];
  private readonly provider: string;
  private readonly providerConfig: Record<string, unknown> | undefined;

  private systemPrompt: string = '';

  private child: ReturnType<typeof spawn> | null = null;
  private dbRowId: number | null = null;
  private sessionId: string | null = null;
  private active = false;
  private stdoutBuffer = '';
  private startedAt: string | null = null;
  private messageCount: number = 0;
  private lastMessageAt: string | null = null;
  private watchdogSoft: ReturnType<typeof setTimeout> | null = null;
  private watchdogWarn: ReturnType<typeof setTimeout> | null = null;
  private watchdogHard: ReturnType<typeof setTimeout> | null = null;
  private pendingToolIds: Set<string> = new Set();
  /** Codex app-server thread ID for persistent sessions. */
  private codexThreadId: string | null = null;
  /** Monotonic counter for Codex JSON-RPC request IDs. */
  private codexRequestSeq = 0;
  /** Gemini ACP session ID captured from session/new response. */
  private geminiSessionId: string | null = null;
  /** Monotonic counter for Gemini ACP JSON-RPC request IDs. */
  private geminiRequestSeq = 0;
  /** Session ID passed to --resume, cleared once the process exits. */
  private resumeAttemptId: string | null = null;
  /** Called instead of the crash message when a --resume attempt is rejected. */
  private readonly onResumeFailed: (() => void) | undefined;
  /** Called when the session crashes unexpectedly (not for resume failures). */
  private readonly onCrash: ((info: SessionCrashInfo) => void) | undefined;
  /**
   * Optional override for crash notification delivery. When provided, the crash
   * message is passed to this callback (allowing the runtime to route it through
   * the outbound queue so it arrives after any buffered turn output). When absent,
   * falls back to a direct messenger.send call.
   */
  private readonly notifyUser: ((msg: string) => void) | undefined;

  private lastCrashNotifiedAt: number | null = null;
  private static readonly CRASH_NOTIFY_COOLDOWN_MS = 60_000;

  private durability: DurabilityEngine | null = null;

  constructor(opts: SessionManagerOptions) {
    this.db = opts.db;
    this.messenger = opts.messenger;
    this.chatJid = opts.chatJid;
    this.onEvent = opts.onEvent;
    this.instanceName = opts.instanceName ?? 'personal';
    this.onResumeFailed = opts.onResumeFailed;
    this.onCrash = opts.onCrash;
    this.notifyUser = opts.notifyUser;
    this.configuredCwd = opts.cwd;
    this.instructionsPath = opts.instructionsPath;
    this.model = opts.model;
    this.pluginDirs = opts.pluginDirs ?? [];
    this.provider = opts.provider ?? 'claude-cli';
    this.providerConfig = opts.providerConfig;
  }

  // ─── Provider helpers ─────────────────────────────────────────────────────

  /** Whether this provider uses a spawn-per-turn model (vs. long-running stdin pipe). */
  private get isSpawnPerTurn(): boolean {
    // Claude CLI, Codex app-server, and Gemini ACP are persistent subprocesses.
    // Others (opencode) still spawn per turn.
    return this.provider !== 'claude-cli'
      && this.provider !== 'codex-cli'
      && this.provider !== 'gemini-cli';
  }

  private getProviderBinary(): string {
    switch (this.provider) {
      case 'codex-cli': return 'codex';
      case 'gemini-cli': return 'gemini';
      case 'opencode-cli': return 'opencode';
      case 'claude-cli':
      default: return 'claude';
    }
  }

  private getProviderArgs(systemPrompt: string, cwd: string, resumeSessionId?: string): string[] {
    const model = this.model;
    switch (this.provider) {
      case 'codex-cli':
        return [
          'app-server',
          '--listen', 'stdio://',
          ...(model ? ['--model', model] : []),
        ];
      case 'gemini-cli':
        return ['--acp'];
      case 'opencode-cli':
        return [
          'run',
          '--format', 'json',
          '--pure',
          ...(model ? ['-m', model] : []),
        ];
      case 'claude-cli':
      default:
        return [
          '-p', '--verbose',
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          '--permission-mode', 'bypassPermissions',
          '--system-prompt', systemPrompt,
          ...(model ? ['--model', model] : []),
          ...this.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
          ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        ];
    }
  }

  private getParser(): (line: string) => AgentEvent | null {
    switch (this.provider) {
      case 'codex-cli': return parseCodexEvent;
      case 'gemini-cli': return parseGeminiAcpEvent;
      case 'opencode-cli': return parseOpenCodeEvent;
      case 'claude-cli':
      default: return parseEvent;
    }
  }

  private handleProviderEvent(event: AgentEvent): void {
    // Debug: log all events for non-Claude providers
    if (this.provider !== 'claude-cli') {
      log.debug({ provider: this.provider, eventType: event.type, sessionId: event.type === 'init' ? event.sessionId : undefined, dbRowId: this.dbRowId }, 'handleProviderEvent');
    }

    if (event.type === 'init' && this.dbRowId !== null) {
      this.sessionId = event.sessionId;
      log.info({ provider: this.provider, chatJid: this.chatJid, sessionId: event.sessionId }, 'provider: captured sessionId');
      updateSessionId(this.db, this.dbRowId, event.sessionId);

      // Codex app-server: capture threadId from thread/started notification
      if (this.provider === 'codex-cli' && event.sessionId) {
        this.codexThreadId = event.sessionId;
        log.info({ chatJid: this.chatJid, codexThreadId: this.codexThreadId }, 'codex: captured threadId');
      }

      // Gemini ACP: capture sessionId from session/new response
      if (this.provider === 'gemini-cli' && event.sessionId) {
        this.geminiSessionId = event.sessionId;
        log.info({ chatJid: this.chatJid, geminiSessionId: this.geminiSessionId }, 'gemini: captured sessionId');
      }

      if (this.provider === 'claude-cli') {
        const transcriptPath = join(
          homedir(),
          '.claude',
          'projects',
          `-home-${userInfo().username}`,
          `${event.sessionId}.jsonl`,
        );
        updateTranscriptPath(this.db, this.dbRowId, transcriptPath);
      }

      if (this.durability) {
        this.durability.upsertSessionCheckpoint(toConversationKey(this.chatJid), {
          sessionId: this.sessionId,
        });
      }
    }

    this.onEvent(event);
  }

  /**
   * Write a JSON-RPC request to a Codex app-server child process.
   * Uses newline-delimited JSON (nd-JSON) framing.
   */
  private sendCodexRequest(
    child: ReturnType<typeof spawn>,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const id = `ws-${++this.codexRequestSeq}`;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id });
    child.stdin!.write(msg + '\n');
    log.debug({ method, id, chatJid: this.chatJid }, 'codex: sent JSON-RPC request');
  }

  /**
   * Write a JSON-RPC response to a Codex app-server server-initiated request
   * (e.g. auto-approving tool execution).
   */
  private sendCodexResponse(
    child: ReturnType<typeof spawn>,
    id: unknown,
    result: unknown,
  ): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    child.stdin!.write(msg + '\n');
    log.debug({ id, chatJid: this.chatJid }, 'codex: sent JSON-RPC response');
  }

  /**
   * Handle Codex app-server server-initiated requests (approval callbacks).
   * Auto-approves all requests since we run in full-access mode.
   */
  private handleCodexServerRequest(parsed: Record<string, unknown>): void {
    if (!this.child) return;
    const id = parsed['id'];
    const method = String(parsed['method'] ?? '');

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'applyPatchApproval' ||
      method === 'execCommandApproval'
    ) {
      log.info({ method, id, chatJid: this.chatJid }, 'codex: auto-approving server request');
      this.sendCodexResponse(this.child, id, { decision: 'approved' });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      // Cannot provide interactive input; deny gracefully
      log.warn({ method, id, chatJid: this.chatJid }, 'codex: denying user input request (non-interactive)');
      this.sendCodexResponse(this.child, id, { input: '' });
      return;
    }

    log.warn({ method, id, chatJid: this.chatJid }, 'codex: unhandled server request');
  }

  private buildSpawnPerTurnPrompt(text: string): string {
    if (!this.systemPrompt) return text;

    return [
      'System instructions:',
      this.systemPrompt,
      '',
      'User message:',
      text,
    ].join('\n');
  }

  private buildSpawnPerTurnArgs(cwd: string, text: string): string[] {
    const prompt = this.buildSpawnPerTurnPrompt(text);

    switch (this.provider) {
      // codex-cli and gemini-cli are now persistent, not spawn-per-turn.

      case 'opencode-cli':
        if (this.sessionId && !this.sessionId.startsWith('opencode-cli-')) {
          // Resume previous session for multi-turn memory
          log.info({ chatJid: this.chatJid, provider: this.provider, sessionId: this.sessionId }, 'opencode: resuming session');
          return [
            'run',
            '--format', 'json',
            '--pure',
            '--session', this.sessionId,
            ...(this.model ? ['-m', this.model] : []),
            prompt,
          ];
        }
        log.info({ chatJid: this.chatJid, provider: this.provider }, 'opencode: fresh session');
        return [
          'run',
          '--format', 'json',
          '--pure',
          ...(this.model ? ['-m', this.model] : []),
          prompt,
        ];

      default:
        return this.getProviderArgs('', cwd);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Return the agent_sessions DB row ID for the current session, or null if not yet created. */
  getDbRowId(): number | null {
    return this.dbRowId;
  }

  trackToolStart(toolId: string): void {
    this.pendingToolIds.add(toolId);
  }

  trackToolEnd(toolId: string): void {
    this.pendingToolIds.delete(toolId);
  }

  get hasPendingTools(): boolean {
    return this.pendingToolIds.size > 0;
  }

  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
  }

  async spawnSession(resumeSessionId?: string, existingRowId?: number): Promise<void> {
    if (this.active && this.child !== null) {
      return;
    }

    const cwd = this.configuredCwd ?? homedir();

    let systemPrompt: string;
    if (this.instructionsPath) {
      const fullInstructionsPath = join(cwd, this.instructionsPath);
      let instructionsContent: string;
      try {
        instructionsContent = readFileSync(fullInstructionsPath, 'utf8');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read instructionsPath "${fullInstructionsPath}": ${message}`);
      }
      systemPrompt = `You are "${this.instanceName}", a personal Claude Code agent running over WhatsApp. ${instructionsContent}`;
    } else {
      systemPrompt = [
        `You are "${this.instanceName}", a personal Claude Code agent running over WhatsApp.`,
        `Your responses are sent as WhatsApp messages — keep them concise.`,
        `You have full access to the local machine via bypassPermissions mode.`,
        `Working directory: ${cwd}`,
      ].join(' ');
    }

    // Spawn-per-turn providers (codex, gemini, opencode) should NOT eagerly spawn
    // at session init — they spawn a fresh process per sendTurn() with the prompt as CLI arg.
    // Mark active and return; the first sendTurn() will spawn the actual process.
    if (this.isSpawnPerTurn) {
      this.active = true;
      this.startedAt = new Date().toISOString();
      this.systemPrompt = systemPrompt;
      this.configuredCwd = cwd;
      // Record in DB with pid=0 (no process yet)
      if (existingRowId !== undefined) {
        this.dbRowId = existingRowId;
      } else {
        this.dbRowId = createSession(this.db, 0, this.instanceName);
      }
      // Emit a synthetic init event so the runtime knows the session is ready
      this.onEvent({ type: 'init', sessionId: `${this.provider}-${Date.now()}` });
      return;
    }

    const binary = this.getProviderBinary();
    const args = this.getProviderArgs(systemPrompt, cwd, resumeSessionId);

    const child = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Security: explicit env allowlist prevents credential leakage to child processes.
      // Without this, Node.js inherits process.env in full — meaning ALL secrets
      // (PINECONE_API_KEY, WHATSOUP_HEALTH_TOKEN, etc.) would flow into every subprocess.
      // Each provider only receives the credentials it actually needs.
      env: buildChildEnv(this.provider),
    });

    this.child = child;
    this.active = true;
    this.stdoutBuffer = '';
    this.startedAt = new Date().toISOString();
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.resumeAttemptId = resumeSessionId ?? null;

    // Record in DB — reuse existing row when provided (avoids duplicate rows on resume)
    const pid = child.pid ?? 0;
    if (existingRowId !== undefined) {
      this.dbRowId = existingRowId;
      updateSessionStatus(this.db, existingRowId, 'active');
    } else {
      this.dbRowId = createSession(this.db, pid, cwd, this.chatJid);
    }

    log.info({ pid, rowId: this.dbRowId, wasResume: resumeSessionId !== undefined, resumeSessionId: resumeSessionId ?? null, provider: this.provider, binary }, `spawned ${binary} process`);

    // Checkpoint: record spawn in durability engine
    if (this.durability) {
      const conversationKey = toConversationKey(this.chatJid);
      this.durability.upsertSessionCheckpoint(conversationKey, {
        claudePid: pid || undefined,
        sessionStatus: 'active',
      });
    }

    // Codex app-server: send initialize + thread/start after spawn
    if (this.provider === 'codex-cli') {
      this.codexThreadId = null;
      this.codexRequestSeq = 0;
      this.sendCodexRequest(child, 'initialize', {
        clientInfo: { name: 'WhatSoup', title: null, version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      this.sendCodexRequest(child, 'thread/start', {
        cwd,
        approvalPolicy: 'never' as const,
        sandbox: 'danger-full-access' as const,
        persistExtendedHistory: true,
        ...(systemPrompt ? { baseInstructions: systemPrompt } : {}),
      });
    }

    // Gemini ACP: send initialize + session/new after spawn
    if (this.provider === 'gemini-cli') {
      this.geminiSessionId = null;
      this.geminiRequestSeq = 0;
      const initReq = buildInitializeRequest(++this.geminiRequestSeq);
      child.stdin!.write(initReq);
      const sessionReq = buildSessionNewRequest(++this.geminiRequestSeq, cwd, [], systemPrompt || undefined);
      child.stdin!.write(sessionReq);
      log.info({ chatJid: this.chatJid }, 'gemini: sent initialize + session/new');
    }

    // Handle spawn errors (e.g. claude binary not in PATH, out of resources)
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        // Binary not installed — configuration error, not a crash
        this.active = false;
        this.child = null;
        this.sessionId = null;
        log.error({ err, chatJid: this.chatJid, binary }, 'claude binary not found (ENOENT)');
        this.notifyUser?.(`_${this.getProviderBinary()} is not installed. Check your provider configuration._`);
        // Do NOT call onCrash — this is not a transient failure
        return;
      }
      log.error({ err, chatJid: this.chatJid }, 'claude process spawn error');
      this.clearTurnWatchdog();
      this.active = false;
      this.child = null;
      this.sessionId = null;
      // Notify user — without this, spawn failures are silent and the chat goes dead
      this.notifyUser?.('_Agent failed to start — will retry on your next message._');
      this.onCrash?.({ exitCode: null, signal: null, sessionId: null, dbRowId: null });
    });

    // Pipe stdout through line parser — use provider-specific parser
    const parse = this.getParser();
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      const lines = this.stdoutBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      this.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        // Codex app-server: intercept server-initiated requests (approval callbacks)
        // before they reach the parser. These have both 'id' and 'method'.
        if (this.provider === 'codex-cli' && line.includes('"method"') && line.includes('"id"')) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg['jsonrpc'] === '2.0' && msg['id'] !== undefined && typeof msg['method'] === 'string') {
              this.handleCodexServerRequest(msg);
              continue;
            }
          } catch {
            // Fall through to normal parsing
          }
        }

        const event = parse(line);
        if (event === null) continue;

        // Temporary debug: log all parsed events for non-Claude providers
        if (this.provider !== 'claude-cli') {
          log.debug({ component: 'session-manager', provider: this.provider, eventType: event.type, rawLine: line.substring(0, 300) }, 'provider stdout parsed');
        }

        if (event.type === 'init' && this.dbRowId !== null) {
          this.handleProviderEvent(event);
          continue;
        }

        this.handleProviderEvent(event);
      }
    });

    // Log stderr but don't act on it
    child.stderr.on('data', (chunk: Buffer) => {
      log.debug({ stderr: chunk.toString('utf8').trim() }, 'claude stderr');
    });

    // Handle unexpected exit
    child.on('exit', (code, signal) => {
      // Ignore exit events from superseded child processes.
      // This prevents a race where /new kills P1 and spawns P2, then P1's
      // delayed SIGTERM exit fires against P2's active state.
      if (this.child !== child) {
        return;
      }

      if (!this.active) {
        // Clean shutdown — already handled
        return;
      }

      // Drain any buffered stdout lines before crash processing.
      // The process may have written final output that was not yet newline-terminated.
      if (this.stdoutBuffer.trim() !== '') {
        for (const line of this.stdoutBuffer.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            const event = parse(trimmed);
            if (event) this.handleProviderEvent(event);
          }
        }
        this.stdoutBuffer = '';
      }

      // Detect resume failure: --resume was used, Claude exited code 1, and
      // no init event arrived (session_id was never set). This means the saved
      // session ID was expired/unknown to Claude's backend.
      const wasResumeAttempt = this.resumeAttemptId !== null;
      const initReceived = this.sessionId !== null;
      const isResumeFail = wasResumeAttempt && code === 1 && !initReceived;

      this.resumeAttemptId = null;

      if (isResumeFail) {
        log.warn({ code, rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, wasResumeAttempt, initReceived }, 'claude resume failed — session expired');
        if (this.dbRowId !== null) {
          log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: child.pid ?? null }, 'session: resume-failed');
          updateSessionStatus(this.db, this.dbRowId, 'resume_failed');
        }
        if (this.durability) {
          this.durability.upsertSessionCheckpoint(toConversationKey(this.chatJid), { sessionStatus: 'orphaned' });
        }
      } else {
        log.warn({ exitCode: code, signal, rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, wasResumeAttempt, initReceived }, 'claude process exited unexpectedly');
        if (this.dbRowId !== null) {
          log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: child.pid ?? null }, 'session: crashed');
          updateSessionStatus(this.db, this.dbRowId, 'crashed');
        }
        if (this.durability) {
          this.durability.upsertSessionCheckpoint(toConversationKey(this.chatJid), { sessionStatus: 'orphaned' });
        }
      }

      // Capture before clearing — onCrash handlers need these for auto-resume
      const crashedSessionId = this.sessionId;
      const crashedDbRowId = this.dbRowId;

      this.clearTurnWatchdog();
      this.active = false;
      this.child = null;
      this.sessionId = null;

      if (isResumeFail) {
        // Let the runtime handle notification + fresh spawn
        this.onResumeFailed?.();
      } else {
        // Allow the runtime to clean up the outbound queue (clears typing heartbeat).
        // onCrash does NOT send 'paused' — the composing indicator times out naturally,
        // acting as a soft signal to the user that the session is in trouble.
        this.onCrash?.({ exitCode: code, signal, sessionId: crashedSessionId, dbRowId: crashedDbRowId });

        // Notify user of unexpected crash (rate-limited to avoid flood on rapid restarts).
        // Deferred via setImmediate so any synchronous onCrash cleanup runs first.

        // Exit code 0 = normal shutdown (e.g. /new, graceful stop) — skip notification entirely.
        if (code === 0 && !signal) {
          log.info({ rowId: this.dbRowId }, 'session exited cleanly (code 0) — no crash notification');
          return;
        }

        const now = Date.now();
        const rateLimited =
          this.lastCrashNotifiedAt !== null &&
          now - this.lastCrashNotifiedAt < SessionManager.CRASH_NOTIFY_COOLDOWN_MS;

        if (rateLimited) {
          log.warn({ rowId: this.dbRowId }, 'crash notification suppressed (rate limited)');
        } else {
          this.lastCrashNotifiedAt = now;
          // Build a deterministic, user-friendly message based on the exit reason
          // code === 0 already returned above; only non-zero exits reach here
          const reason = signal
            ? `terminated by signal ${signal}`
            : `exited with code ${code}`;
          const msg = `Agent session ended (${reason}). Send any message to start a new session.`;
          if (this.notifyUser) {
            // Route through runtime's outbound queue so it arrives after buffered turn output.
            setImmediate(() => this.notifyUser!(msg));
          } else {
            const chatJid = this.chatJid;
            setImmediate(() => {
              this.messenger
                .sendMessage(chatJid, msg)
                .catch((err) => log.error({ err }, 'failed to send crash notice'));
            });
          }
        }
      }
    });
  }

  clearTurnWatchdog(): void {
    clearTimeout(this.watchdogSoft ?? undefined);
    clearTimeout(this.watchdogWarn ?? undefined);
    clearTimeout(this.watchdogHard ?? undefined);
    this.watchdogSoft = null;
    this.watchdogWarn = null;
    this.watchdogHard = null;
    this.pendingToolIds.clear();
  }

  /**
   * Reset all watchdog tiers — call on ANY agent activity (tool_use, tool_result,
   * assistant_text, compact_boundary) so that only truly stalled sessions are killed.
   */
  tickWatchdog(): void {
    if (!this.active || this.child === null) return;
    this.clearTurnWatchdog();
    this.armWatchdog();
  }

  private armWatchdog(): void {
    this.watchdogSoft = setTimeout(() => this.handleWatchdogSoft(), WATCHDOG_SOFT_MS);
    this.watchdogWarn = setTimeout(() => this.handleWatchdogWarn(), WATCHDOG_WARN_MS);
    this.watchdogHard = setTimeout(() => this.handleWatchdogHard(), WATCHDOG_HARD_MS);
  }

  private handleWatchdogSoft(): void {
    this.watchdogSoft = null;
    if (!this.active || this.child === null) return;
    if (this.hasPendingTools) {
      log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'watchdog_soft', pendingTools: this.pendingToolIds.size }, 'agent busy 10 min — long-running tool in progress');
      this.notifyUser?.('_Agent is running a long operation (10+ min). Still working..._');
    } else {
      log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'watchdog_soft' }, 'agent idle 10 min — still alive, notifying user');
      this.notifyUser?.('_Agent has been working for 10+ minutes without responding. Still running..._');
    }
  }

  private handleWatchdogWarn(): void {
    this.watchdogWarn = null;
    if (!this.active || this.child === null) return;
    if (this.hasPendingTools) {
      log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'watchdog_warn', pendingTools: this.pendingToolIds.size }, 'agent busy 20 min — long-running tool, may be stalled');
      this.notifyUser?.('⚠️ _Agent has been running a long operation for 20+ min. Send any message to check in._');
    } else {
      log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'watchdog_warn' }, 'agent idle 20 min — may be stalled');
      this.notifyUser?.('⚠️ _Agent has been silent for 20+ minutes. Will be terminated in 10 minutes if no activity. Send any message to keep alive._');
    }
  }

  private handleWatchdogHard(): void {
    this.watchdogHard = null;
    if (!this.active || this.child === null) return;
    log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'turn_watchdog' }, 'turn watchdog fired — killing stalled Claude process');
    // Notify user with a specific message before the kill — the generic crash
    // notice ("Agent session crashed") follows via the exit handler, but this
    // message explains WHY it was terminated.
    this.notifyUser?.('_Session terminated after 30 minutes of inactivity — restarting._');
    this.child?.kill('SIGKILL');
  }

  /** Write a user message turn to the agent — via stdin (Claude) or spawn-per-turn (others). */
  async sendTurn(text: string): Promise<void> {
    if (!this.active) {
      throw new Error('No active session. Call spawnSession() first.');
    }

    if (this.isSpawnPerTurn) {
      // Clear any partial JSON from the previous turn before spawning a new process.
      // Without this, leftover bytes in the buffer can corrupt the next turn's output.
      this.stdoutBuffer = '';

      // Reset provider-specific parser state — module-level flags (like OpenCode's
      // _firstStepSeen) persist across turns since the module stays loaded.
      if (this.provider === 'opencode-cli') {
        resetOpenCodeParserState();
      }

      // Spawn-per-turn providers: kill any existing process and spawn a new one
      // with the user prompt appended as a CLI argument.
      if (this.child) {
        this.child.kill('SIGTERM');
        this.child = null;
      }

      const cwd = this.configuredCwd ?? homedir();

      const args = this.buildSpawnPerTurnArgs(cwd, text);
      const binary = this.getProviderBinary();
      const parse = this.getParser();

      const child = spawn(binary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(this.provider),
      });

      this.child = child;

      // Spawn-per-turn providers receive their prompt as CLI args, not stdin.
      // Close stdin immediately so providers that read stdin (like Codex exec's
      // read_to_end()) don't block waiting for EOF.
      child.stdin.end();

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          // Binary not installed — configuration error, not a transient crash
          this.active = false;
          this.child = null;
          log.error({ err, chatJid: this.chatJid, provider: this.provider, binary }, 'provider binary not found (ENOENT)');
          this.notifyUser?.(`_${this.getProviderBinary()} is not installed. Check your provider configuration._`);
          // Do NOT call onCrash — this is not a transient failure
          return;
        }
        log.error({ err, chatJid: this.chatJid, provider: this.provider }, 'provider process spawn error');
        this.clearTurnWatchdog();
        this.active = false;
        this.child = null;
        this.notifyUser?.('_Agent failed to start — will retry on your next message._');
        this.onCrash?.({ exitCode: null, signal: null, sessionId: null, dbRowId: null });
      });

      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString('utf8');
        const lines = this.stdoutBuffer.split('\n');
        this.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const event = parse(line);
          if (event === null) continue;
          this.handleProviderEvent(event);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        log.debug({ stderr: chunk.toString('utf8').trim(), provider: this.provider }, 'provider stderr');
      });

      // For spawn-per-turn, process exit is normal (one turn = one process).
      // Emit any remaining buffered output, then mark the turn as complete.
      // Use setImmediate to let pending stdout data chunks drain before we process.
      child.on('exit', (code, signal) => {
        if (this.child !== child) return; // superseded

        // Defer drain to next tick — stdout 'data' events may still be queued
        // in the event loop after the 'exit' event fires.
        setImmediate(() => {

        // Drain buffered output
        if (this.stdoutBuffer.trim() !== '') {
          for (const line of this.stdoutBuffer.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
              const event = parse(trimmed);
              if (event) {
                if (this.provider !== 'claude-cli') {
                  log.debug({ provider: this.provider, eventType: event.type }, 'spawn-per-turn exit drain');
                }
                this.handleProviderEvent(event);
              }
            }
          }
          this.stdoutBuffer = '';
        }

        this.clearTurnWatchdog();

        // Non-zero exit on spawn-per-turn = error for this turn, but session stays active
        if (code !== 0 && code !== null) {
          log.warn({ exitCode: code, signal, provider: this.provider, chatJid: this.chatJid }, 'provider turn process exited with error');
        }
        }); // end setImmediate
      });
    } else {
      // Persistent process: pipe turns via stdin (JSONL for Claude, JSON-RPC for Codex/Gemini)
      if (this.child === null) {
        throw new Error('No active session. Call spawnSession() first.');
      }

      // Gemini ACP: wait for sessionId from session/new response, then write session/prompt
      if (this.provider === 'gemini-cli') {
        if (!this.geminiSessionId) {
          const waitStart = Date.now();
          while (!this.geminiSessionId && Date.now() - waitStart < 15_000) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!this.geminiSessionId) {
            throw new Error('Gemini sessionId not captured after 15s.');
          }
        }
        const req = buildSessionPromptRequest(++this.geminiRequestSeq, this.geminiSessionId, text);
        this.child.stdin!.write(req);
        if (this.dbRowId !== null) {
          incrementMessageCount(this.db, this.dbRowId);
        }
        this.clearTurnWatchdog();
        this.armWatchdog();
        this.messageCount += 1;
        this.lastMessageAt = new Date().toISOString();
        return;
      }

      let payload: string;
      if (this.provider === 'codex-cli') {
        // Codex app-server: wait for threadId from thread/started response
        // (spawnSession sends initialize + thread/start, response arrives async on stdout)
        if (!this.codexThreadId) {
          const waitStart = Date.now();
          const THREAD_WAIT_MS = 15_000;
          while (!this.codexThreadId && Date.now() - waitStart < THREAD_WAIT_MS) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!this.codexThreadId) {
            throw new Error('Codex threadId not captured after 15s. app-server may have failed to initialize.');
          }
        }
        const id = `ws-${++this.codexRequestSeq}`;
        payload = JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/start',
          params: {
            threadId: this.codexThreadId,
            input: [{ type: 'text', text, text_elements: [] }],
          },
          id,
        });
      } else {
        // Claude-cli: stream-json user message
        payload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        });
      }

      const stdin = this.child.stdin;
      if (!stdin) throw new Error('Child process stdin is not available');

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            stdin.write(payload + '\n', 'utf8', (err) => {
              if (err) reject(err);
              else resolve();
            });
          }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('STDIN_WRITE_TIMEOUT: agent not reading input')),
              STDIN_WRITE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      }
    }

    if (this.dbRowId !== null) {
      incrementMessageCount(this.db, this.dbRowId);
    }
    this.clearTurnWatchdog(); // clear any previous watchdog before arming a new one
    this.armWatchdog();
    this.messageCount += 1;
    this.lastMessageAt = new Date().toISOString();
  }

  /** Kill the current session and spawn a fresh one. */
  async handleNew(): Promise<void> {
    await this.shutdown(false); // user-initiated: mark ended, not suspended
    await this.spawnSession();
  }

  /** Return lightweight status without touching the DB. */
  getStatus(): {
    active: boolean;
    pid: number | null;
    sessionId: string | null;
    startedAt: string | null;
    messageCount: number;
    lastMessageAt: string | null;
  } {
    return {
      active: this.active,
      pid: this.child?.pid ?? null,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
    };
  }

  /**
   * Kill child process and mark session.
   * @param suspend - true (default) = suspended (bot shutdown, resumable);
   *                  false = ended (user chose /new, not resumable).
   */
  async shutdown(suspend = true): Promise<void> {
    this.clearTurnWatchdog();
    this.active = false; // Suppress crash notification for clean shutdown

    const currentPid = this.child?.pid ?? null;

    // DB update and durability checkpoint run unconditionally when dbRowId exists.
    // For spawn-per-turn providers, there may be no child in-flight at shutdown time,
    // but the session row still needs to be closed out.
    if (this.dbRowId !== null) {
      if (suspend) {
        log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: currentPid }, 'session: suspended');
        updateSessionStatus(this.db, this.dbRowId, 'suspended');
      } else {
        log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: currentPid }, 'session: ended');
        updateSessionStatus(this.db, this.dbRowId, 'ended');
      }
    }

    // Checkpoint: record suspend/end status (runs regardless of child presence)
    if (this.durability) {
      const conversationKey = toConversationKey(this.chatJid);
      this.durability.upsertSessionCheckpoint(conversationKey, {
        sessionStatus: suspend ? 'suspended' : 'ended',
      });
    }

    // Kill the child only if one is running
    if (this.child !== null) {
      const terminatedSessionId = this.sessionId;
      this.child.kill('SIGTERM');
      this.child = null;
      log.info({ chatJid: this.chatJid, sessionId: terminatedSessionId, pid: currentPid }, 'claude process terminated');
    }

    this.sessionId = null;
    this.dbRowId = null;
    this.startedAt = null;
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.codexThreadId = null;
  }
}

/**
 * Format the age of a session for human-readable display.
 * @param isoUtcString - ISO UTC timestamp string (e.g. from started_at)
 */
export function formatAge(isoUtcString: string): string {
  const ms = Date.now() - new Date(isoUtcString).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
