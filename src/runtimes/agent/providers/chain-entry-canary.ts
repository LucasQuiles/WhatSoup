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

export interface ChainEntryCanaryResult {
  status: 'ok' | 'failed' | 'timeout' | 'unknown';
  /** Sanitized stderr/stdout tail on failure; null on ok/unknown. */
  evidence: string | null;
  durationMs: number;
}

/** Strip bearer-token-looking material so evidence can flow into alerts. */
function sanitizeEvidence(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED-KEY]')
    .slice(-240);
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
      settle({ status: 'failed', evidence: sanitizeEvidence(String(err)) });
      return;
    }

    killTimer = setTimeout(() => {
      try { child.kill(SIGNAL.KILL); } catch (killErr) { log.debug({ err: killErr }, 'canary kill after timeout — child already gone'); }
      settle({ status: 'timeout', evidence: `no completion within ${timeoutMs}ms` });
    }, timeoutMs);
    killTimer.unref?.();

    child.on('error', (err) => {
      settle({ status: 'failed', evidence: sanitizeEvidence(String(err)) });
    });
    child.stdout?.on('data', (chunk: Buffer) => { stdoutBuffer += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuffer += chunk.toString(); });
    child.on('close', (code, signal) => {
      if (code === 0 && stdoutBuffer.trim() !== '') {
        settle({ status: 'ok', evidence: null });
        return;
      }
      const detail = stderrBuffer.trim() || stdoutBuffer.trim() || '(no output)';
      settle({
        status: 'failed',
        evidence: sanitizeEvidence(`exit=${code ?? 'null'} signal=${signal ?? 'none'} ${detail}`),
      });
    });

    try {
      child.stdin?.end(prompt);
    } catch (stdinErr) {
      // stdin already closed by a fast-failing child — close handler settles.
      log.debug({ err: stdinErr }, 'canary stdin write raced child exit');
    }
  });
}
