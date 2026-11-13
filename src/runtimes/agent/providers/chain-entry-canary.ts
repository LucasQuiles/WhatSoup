// src/runtimes/agent/providers/chain-entry-canary.ts
// Real-completion canary for one fallback chain entry.
//
// Metadata probes (credential validity, binary presence, model catalogs) are
// structurally blind to account-level death: a billing-suspended provider
// account still authenticates and lists models — only an actual completion
// call fails (fleet incident 2026-08-15; the dead entry's models endpoint
// returned 200 the whole time). This probe issues the smallest real turn the
// provider will accept THROUGH the same binary + argv + stdin transport the
// runtime itself uses, so the evidence is the system's own path, not a proxy.
//
// Fail-closed on the question it asks ("can this entry serve a turn right
// now?"): a non-zero exit, a timeout, a spawn error, output past the byte
// limit, or anything but one complete tool-free "OK" turn is a FAILURE with
// evidence. 'unknown' is reserved for entries the canary cannot probe (no CLI
// binary transport) — never for a probe that ran and misbehaved.

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SIGNAL } from '../../../lib/signals.ts';
import { createChildLogger } from '../../../logger.ts';
import { systemClock } from '../../../lib/clock.ts';
import { killSessionTree } from '../process-tree.ts';
import { createOpenCodeParser } from './opencode-parser.ts';

const log = createChildLogger('chain-entry-canary');

/**
 * Bounded reason a canary probe failed — the ONLY failure detail allowed to
 * leave this module for an operator-facing surface (/health, alerts).
 *
 * The raw provider tail cannot go there. Sanitization here strips credential
 * SHAPES, not provider prose, and providers put arbitrary content in error
 * bodies: the 2026-08-16 live sweep captured a z.ai request id plus a full
 * JSON responseBody, and a Moonshot account-status sentence. Those are
 * unbounded third-party strings on a surface that must stay content-free, so
 * operator surfaces carry this closed set and the raw tail stays in debug logs.
 */
export type ChainEntryCanaryFailureClass =
  /** Credential/account rejected: auth, permission, suspension, balance. */
  | 'auth'
  /** Rate/quota exhaustion — recovers on its own when the window resets. */
  | 'quota'
  /** No completion within the probe deadline (kill-timer fired). */
  | 'timeout'
  /** The binary could not be spawned or died before producing output. */
  | 'spawn'
  /** Clean exit with no usable completion text. */
  | 'empty'
  /** Ran and failed, but matched no known signature. */
  | 'unknown';

export interface ChainEntryCanaryResult {
  status: 'ok' | 'failed' | 'timeout' | 'unknown';
  /** Sanitized stderr/stdout tail on failure; null on ok/unknown.
   *  DEBUG-LOG ONLY — never render on /health or in an alert body. */
  evidence: string | null;
  /** Operator-safe bounded failure reason; null on ok/unknown. */
  failureClass: ChainEntryCanaryFailureClass | null;
  durationMs: number;
}

/** Strip bearer-token-looking material. Credential shapes only — this does
 *  NOT make the string operator-safe; see ChainEntryCanaryFailureClass. */
function sanitizeEvidence(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED-KEY]')
    .slice(-240);
}

/**
 * Captured stdout cap, in bytes as read from the pipe (not decoded string
 * length). A canary reply is a few hundred bytes of JSON events; output past
 * this bound fails the probe and stops the child.
 */
export const CANARY_OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Stderr is evidence only; keep its last bytes. */
const CANARY_STDERR_TAIL_BYTES = 4 * 1024;
/** SIGTERM grace before killSessionTree escalates the canary tree to SIGKILL. */
const CANARY_TREE_TERM_GRACE_MS = 2_000;
const CANARY_REPLY = /^ok[.!]?$/i;

/**
 * Judge `opencode run --format json` output: exactly one tool-free turn — a
 * step_start, its assistant text, then one terminal step_finish "stop" with
 * nothing meaningful after it — whose text is the requested OK. Blank lines are
 * skipped. Anything else (a missing start, a second step or result, a tool
 * call, an unparseable line, an unrecognized event) fails. Returns null when it
 * passes, else a short content-free reason.
 */
function incompleteCompletionReason(stdout: string): string | null {
  const parser = createOpenCodeParser();
  let phase: 'awaiting_start' | 'in_turn' | 'finished' = 'awaiting_start';
  let reply = '';
  for (const line of stdout.split('\n')) {
    const parsed = parser.parse(line);
    if (parsed === null) continue;
    if (phase === 'finished') return `${parsed.type} event after the terminal result`;
    if (phase === 'awaiting_start') {
      if (parsed.type !== 'init') return `${parsed.type} event before the turn started`;
      phase = 'in_turn';
    } else if (parsed.type === 'assistant_text') {
      reply += parsed.text;
    } else if (parsed.type === 'result') {
      phase = 'finished';
    } else {
      return `unexpected ${parsed.type} event`;
    }
  }
  if (phase !== 'finished') return 'no terminal result';
  return CANARY_REPLY.test(reply.trim()) ? null : 'reply was not OK';
}

/**
 * Map a raw failure tail onto the bounded class. Signature-matched against
 * real provider output observed on the fleet; order matters — quota wording
 * frequently co-occurs with a 4xx that would otherwise read as auth.
 */
export function classifyCanaryFailure(raw: string): ChainEntryCanaryFailureClass {
  const text = raw.toLowerCase();
  if (/quota|rate.?limit|too many requests|\b429\b|limit exhausted|exceeded your/.test(text)) {
    return 'quota';
  }
  if (/suspend|insufficient balance|unauthor|forbidden|invalid api key|authentication|\b401\b|\b403\b|recharge/.test(text)) {
    return 'auth';
  }
  if (/enoent|spawn|command not found|eacces/.test(text)) return 'spawn';
  if (/no completion within/.test(text)) return 'timeout';
  if (/\(no output\)/.test(text)) return 'empty';
  return 'unknown';
}

/**
 * Run one tiny completion through `binary` with `args`, writing `prompt` to
 * stdin (the runtime's own non-TTY transport — prompts never ride argv).
 * Never throws; never logs the environment.
 */
export async function probeChainEntryCompletion(
  binary: string,
  args: string[],
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn,
): Promise<ChainEntryCanaryResult> {
  const startedAt = systemClock.now();
  return new Promise<ChainEntryCanaryResult>((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawnImpl> | undefined;
    // Set once the probe decides to stop the child: its later close must not
    // replace the timeout or overflow verdict.
    let stopping = false;

    const settle = (result: Omit<ChainEntryCanaryResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ...result, durationMs: systemClock.now() - startedAt });
    };

    // Stop a child that is still running, with its descendants, through the
    // shared process-tree reaper. The result is settled only after the reap,
    // and an unconfirmed reap is recorded in the (debug-only) evidence.
    const stopThenSettle = (result: Omit<ChainEntryCanaryResult, 'durationMs'>): void => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(killTimer);
      const target = child;
      if (target?.pid === undefined || target.exitCode !== null || target.signalCode !== null) {
        try { target?.kill(SIGNAL.KILL); } catch (killErr) { log.debug({ err: killErr }, 'canary kill — child already gone'); }
        settle(result);
        return;
      }
      let outcome: string | null = null;
      void killSessionTree(target, SIGNAL.TERM, {
        generationMarker: `chain-canary:${randomUUID()}`,
        termGraceMs: CANARY_TREE_TERM_GRACE_MS,
        onOutcome: (reaped) => { outcome = reaped.outcome; },
      }).then(
        () => {
          if (outcome === 'unresolved_ambiguous') {
            log.warn({ pid: target.pid }, 'chain canary process tree cleanup left ambiguous processes');
            settle({ ...result, evidence: `${result.evidence ?? ''} [cleanup ambiguous]`.trim() });
            return;
          }
          settle(result);
        },
        (err: unknown) => {
          log.warn({ err, pid: target.pid }, 'chain canary process tree cleanup failed');
          settle({ ...result, evidence: `${result.evidence ?? ''} [cleanup failed]`.trim() });
        },
      );
    };

    try {
      child = spawnImpl(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        env,
      } as SpawnOptionsWithoutStdio);
    } catch (err) {
      const evidence = sanitizeEvidence(String(err));
      settle({ status: 'failed', evidence, failureClass: 'spawn' });
      return;
    }
    const spawned = child;

    killTimer = setTimeout(() => {
      stopThenSettle({ status: 'timeout', evidence: `no completion within ${timeoutMs}ms`, failureClass: 'timeout' });
    }, timeoutMs);
    killTimer.unref?.();

    spawned.on('error', (err) => {
      // The reaper's own kill can surface an error while the probe is stopping
      // the child; the reap result settles with the original verdict.
      if (stopping) {
        log.debug({ err }, 'canary child error during cleanup');
        return;
      }
      const evidence = sanitizeEvidence(String(err));
      settle({ status: 'failed', evidence, failureClass: classifyCanaryFailure(evidence) });
    });
    // A child that exits or closes stdin before reading the prompt makes the
    // write fail with EPIPE; without a listener that error would be uncaught.
    spawned.stdin?.on('error', (err) => {
      log.debug({ err }, 'canary stdin write failed');
    });
    spawned.stdout?.on('data', (chunk: Buffer) => {
      if (settled || stopping) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > CANARY_OUTPUT_LIMIT_BYTES) {
        stopThenSettle({
          status: 'failed',
          evidence: `output exceeded ${CANARY_OUTPUT_LIMIT_BYTES} bytes`,
          failureClass: 'unknown',
        });
        return;
      }
      stdoutChunks.push(chunk);
    });
    spawned.stderr?.on('data', (chunk: Buffer) => {
      const joined = Buffer.concat([stderrTail, chunk]);
      stderrTail = joined.subarray(Math.max(0, joined.length - CANARY_STDERR_TAIL_BYTES));
    });
    spawned.on('close', (code, signal) => {
      if (stopping) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const incomplete = incompleteCompletionReason(stdout);
      if (code === 0 && incomplete === null) {
        settle({ status: 'ok', evidence: null, failureClass: null });
        return;
      }
      const detail = stderrTail.toString('utf8').trim() || stdout.trim() || '(no output)';
      const reason = code === 0 ? ` ${incomplete}:` : '';
      const evidence = sanitizeEvidence(`exit=${code ?? 'null'} signal=${signal ?? 'none'}${reason} ${detail}`);
      settle({ status: 'failed', evidence, failureClass: classifyCanaryFailure(evidence) });
    });

    try {
      spawned.stdin?.end(prompt);
    } catch (stdinErr) {
      // stdin already closed by a fast-failing child — close handler settles.
      log.debug({ err: stdinErr }, 'canary stdin write raced child exit');
    }
  });
}
