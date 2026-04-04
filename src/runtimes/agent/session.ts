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
import { parseGeminiEvent } from './providers/gemini-parser.ts';

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

  // Strip undefined values (env vars not set in the parent process)
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  ) as NodeJS.ProcessEnv;
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
    return this.provider !== 'claude-cli';
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
          'exec', '--json',
          '--dangerously-bypass-approvals-and-sandbox',
          ...(model ? ['-m', model] : []),
          '-C', cwd,
        ];
      case 'gemini-cli':
        return [
          '-p',
          '--output-format', 'stream-json',
          '--yolo',
          ...(model ? ['-m', model] : []),
        ];
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
      case 'gemini-cli': return parseGeminiEvent;
      case 'opencode-cli':
        // OpenCode's JSON format (step_start/text/step_finish) differs from Claude's.
        // A dedicated parser should be implemented. For now, fall through to Claude
        // parser which will produce 'unknown' events for unrecognized types.
        return parseEvent;
      case 'claude-cli':
      default: return parseEvent;
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
        const event = parse(line);
        if (event === null) continue;

        if (event.type === 'init' && this.dbRowId !== null) {
          this.sessionId = event.sessionId;
          updateSessionId(this.db, this.dbRowId, event.sessionId);
          // Derive and persist transcript path
          const transcriptPath = join(
            homedir(),
            '.claude',
            'projects',
            `-home-${userInfo().username}`,
            `${event.sessionId}.jsonl`,
          );
          if (this.dbRowId !== null) {
            updateTranscriptPath(this.db, this.dbRowId, transcriptPath);
          }
          // Durability checkpoint: record sessionId once Claude confirms it
          if (this.durability) {
            this.durability.upsertSessionCheckpoint(toConversationKey(this.chatJid), {
              sessionId: this.sessionId,
            });
          }
        }

        this.onEvent(event);
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
            if (event) this.onEvent(event);
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

      // Spawn-per-turn providers: kill any existing process and spawn a new one
      // with the user prompt appended as a CLI argument.
      if (this.child) {
        this.child.kill('SIGTERM');
        this.child = null;
      }

      const cwd = this.configuredCwd ?? homedir();
      const systemPrompt = ''; // system prompt not used as CLI arg for non-Claude providers
      const baseArgs = this.getProviderArgs(systemPrompt, cwd);

      // Append the user message as the final argument (the prompt)
      const args = [...baseArgs, text];
      const binary = this.getProviderBinary();
      const parse = this.getParser();

      const child = spawn(binary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(this.provider),
      });

      this.child = child;

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
          this.onEvent(event);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        log.debug({ stderr: chunk.toString('utf8').trim(), provider: this.provider }, 'provider stderr');
      });

      // For spawn-per-turn, process exit is normal (one turn = one process).
      // Emit any remaining buffered output, then mark the turn as complete.
      child.on('exit', (code, signal) => {
        if (this.child !== child) return; // superseded

        // Drain buffered output
        if (this.stdoutBuffer.trim() !== '') {
          for (const line of this.stdoutBuffer.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
              const event = parse(trimmed);
              if (event) this.onEvent(event);
            }
          }
          this.stdoutBuffer = '';
        }

        this.clearTurnWatchdog();

        // Non-zero exit on spawn-per-turn = error for this turn, but session stays active
        if (code !== 0 && code !== null) {
          log.warn({ exitCode: code, signal, provider: this.provider, chatJid: this.chatJid }, 'provider turn process exited with error');
        }
      });
    } else {
      // Claude-cli: long-running process, pipe turns via stdin JSONL
      if (this.child === null) {
        throw new Error('No active session. Call spawnSession() first.');
      }

      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });

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
