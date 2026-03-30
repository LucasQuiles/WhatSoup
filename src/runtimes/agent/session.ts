// src/runtimes/agent/session.ts
// SessionManager owns the Claude Code child process lifecycle.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../core/database.ts';
import type { Messenger } from '../../core/types.ts';
import { createChildLogger } from '../../logger.ts';
import { createSession, incrementMessageCount, updateSessionId, updateSessionStatus, updateTranscriptPath } from './session-db.ts';
import { parseEvent } from './stream-parser.ts';
import type { AgentEvent } from './stream-parser.ts';

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

export interface SessionManagerOptions {
  db: Database;
  messenger: Messenger;
  chatJid: string;
  onEvent: (event: AgentEvent) => void;
  instanceName?: string;
  onResumeFailed?: () => void;
  onCrash?: () => void;
  notifyUser?: (msg: string) => void;
  cwd?: string;
  instructionsPath?: string;
  model?: string;
}

export class SessionManager {
  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly chatJid: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly instanceName: string;
  private readonly configuredCwd: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly model: string | undefined;

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
  /** @deprecated Alias for backward-compat in tests. */
  private get turnWatchdog() { return this.watchdogHard; }
  /** Session ID passed to --resume, cleared once the process exits. */
  private resumeAttemptId: string | null = null;
  /** Called instead of the crash message when a --resume attempt is rejected. */
  private readonly onResumeFailed: (() => void) | undefined;
  /** Called when the session crashes unexpectedly (not for resume failures). */
  private readonly onCrash: (() => void) | undefined;
  /**
   * Optional override for crash notification delivery. When provided, the crash
   * message is passed to this callback (allowing the runtime to route it through
   * the outbound queue so it arrives after any buffered turn output). When absent,
   * falls back to a direct messenger.send call.
   */
  private readonly notifyUser: ((msg: string) => void) | undefined;

  private lastCrashNotifiedAt: number | null = null;
  private static readonly CRASH_NOTIFY_COOLDOWN_MS = 60_000;

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
  }

  // ─── Public API ───────────────────────────────────────────────────────────

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

    const child = spawn(
      'claude',
      [
        '-p',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
        '--system-prompt', systemPrompt,
        ...(this.model ? ['--model', this.model] : []),
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

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

    log.info({ pid, rowId: this.dbRowId, wasResume: resumeSessionId !== undefined, resumeSessionId: resumeSessionId ?? null }, 'spawned claude process');

    // Handle spawn errors (e.g. claude binary not in PATH, out of resources)
    child.on('error', (err) => {
      log.error({ err, chatJid: this.chatJid }, 'claude process spawn error');
      // Clean up session state as if the process crashed
      this.clearTurnWatchdog();
      this.active = false;
      this.child = null;
      this.sessionId = null;
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
            const event = parseEvent(trimmed);
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
      } else {
        log.warn({ exitCode: code, signal, rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, wasResumeAttempt, initReceived }, 'claude process exited unexpectedly');
        if (this.dbRowId !== null) {
          log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: child.pid ?? null }, 'session: crashed');
          updateSessionStatus(this.db, this.dbRowId, 'crashed');
        }
      }

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
        this.onCrash?.();

        // Notify user of unexpected crash (rate-limited to avoid flood on rapid restarts).
        // Deferred via setImmediate so any synchronous onCrash cleanup runs first.
        const now = Date.now();
        const suppressed =
          this.lastCrashNotifiedAt !== null &&
          now - this.lastCrashNotifiedAt < SessionManager.CRASH_NOTIFY_COOLDOWN_MS;

        if (suppressed) {
          log.warn({ rowId: this.dbRowId }, 'crash notification suppressed (rate limited)');
        } else {
          this.lastCrashNotifiedAt = now;
          const msg = 'Agent session crashed. Send any message to start a new session.';
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
    log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'watchdog_soft' }, 'agent idle 10 min — still alive, notifying user');
    this.watchdogSoft = null;
    this.notifyUser?.('_Agent has been working for 10+ minutes without responding. Still running..._');
  }

  private handleWatchdogWarn(): void {
    log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'watchdog_warn' }, 'agent idle 20 min — may be stalled');
    this.watchdogWarn = null;
    this.notifyUser?.('⚠️ _Agent has been silent for 20+ minutes. Will be terminated in 10 minutes if no activity. Send any message to keep alive._');
  }

  private handleWatchdogHard(): void {
    log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'turn_watchdog' }, 'turn watchdog fired — killing stalled Claude process');
    this.watchdogHard = null;
    this.child?.kill('SIGKILL');
  }

  /** Write a user message turn as JSONL to the child stdin. */
  async sendTurn(text: string): Promise<void> {
    if (this.child === null || !this.active) {
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
    if (this.child !== null) {
      this.clearTurnWatchdog();
      this.active = false; // Suppress crash notification for clean shutdown

      const currentPid = this.child.pid ?? null;
      if (this.dbRowId !== null) {
        if (suspend) {
          log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: currentPid }, 'session: suspended');
          updateSessionStatus(this.db, this.dbRowId, 'suspended');
        } else {
          log.info({ rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, pid: currentPid }, 'session: ended');
          updateSessionStatus(this.db, this.dbRowId, 'ended');
        }
      }

      const terminatedSessionId = this.sessionId;
      this.child.kill('SIGTERM');
      this.child = null;
      this.sessionId = null;
      this.dbRowId = null;
      this.startedAt = null;
      this.messageCount = 0;
      this.lastMessageAt = null;

      log.info({ chatJid: this.chatJid, sessionId: terminatedSessionId, pid: currentPid }, 'claude process terminated');
    }
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
