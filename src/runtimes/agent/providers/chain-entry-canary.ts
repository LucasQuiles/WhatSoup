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
// now?"): a non-zero exit, a timeout, or a spawn error is a FAILURE with
// evidence. 'unknown' is reserved for entries the canary cannot probe (no CLI
// binary transport) — never for a probe that ran and misbehaved.

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { SIGNAL } from '../../../lib/signals.ts';
import { createChildLogger } from '../../../logger.ts';
import { systemClock } from '../../../lib/clock.ts';

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
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: Omit<ChainEntryCanaryResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ...result, durationMs: systemClock.now() - startedAt });
    };

    let child: ReturnType<typeof spawnImpl>;
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

    killTimer = setTimeout(() => {
      try { child.kill(SIGNAL.KILL); } catch (killErr) { log.debug({ err: killErr }, 'canary kill after timeout — child already gone'); }
      settle({ status: 'timeout', evidence: `no completion within ${timeoutMs}ms`, failureClass: 'timeout' });
    }, timeoutMs);
    killTimer.unref?.();

    child.on('error', (err) => {
      const evidence = sanitizeEvidence(String(err));
      settle({ status: 'failed', evidence, failureClass: classifyCanaryFailure(evidence) });
    });
    child.stdout?.on('data', (chunk: Buffer) => { stdoutBuffer += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuffer += chunk.toString(); });
    child.on('close', (code, signal) => {
      if (code === 0 && stdoutBuffer.trim() !== '') {
        settle({ status: 'ok', evidence: null, failureClass: null });
        return;
      }
      const detail = stderrBuffer.trim() || stdoutBuffer.trim() || '(no output)';
      const evidence = sanitizeEvidence(`exit=${code ?? 'null'} signal=${signal ?? 'none'} ${detail}`);
      settle({ status: 'failed', evidence, failureClass: classifyCanaryFailure(evidence) });
    });

    try {
      child.stdin?.end(prompt);
    } catch (stdinErr) {
      // stdin already closed by a fast-failing child — close handler settles.
      log.debug({ err: stdinErr }, 'canary stdin write raced child exit');
    }
  });
}
