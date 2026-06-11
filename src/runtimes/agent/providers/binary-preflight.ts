// src/runtimes/agent/providers/binary-preflight.ts
// Pre-flight probe: verify a provider binary is spawnable on this host.
//
// Fail-open contract: anything other than a definitive ENOENT is 'unknown',
// so a binary that exists but misbehaves on --version (non-zero exit, garbled
// output) is still considered present — presence is the question, not perfect
// operation. The key invariant is that a clean ENOENT → 'missing' so operators
// receive a loud alert when the binary is simply not installed.

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';

export interface BinaryPreflightResult {
  status: 'present' | 'missing' | 'unknown';
  /** First line of stdout from `binary --version` when present, else null. */
  version: string | null;
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe whether `binary` is spawnable on this host.
 *
 * Spawns `binary ['--version']` with piped stdio and a 5 s timeout.
 *
 * - `ENOENT` spawn error → `{ status: 'missing', version: null }`
 * - stdout produced before exit (regardless of exit code) → `{ status: 'present', version: <first line> }`
 * - timeout or any non-ENOENT error → `{ status: 'unknown', version: null }` (fail-open)
 *
 * Injectable `spawnImpl` for unit tests (defaults to `node:child_process` `spawn`).
 * Never throws.
 */
export async function probeFallbackBinary(
  binary: string,
  spawnImpl: typeof spawn = spawn,
): Promise<BinaryPreflightResult> {
  return new Promise<BinaryPreflightResult>((resolve) => {
    let settled = false;
    let stdoutBuffer = '';
    // Declare killTimer before settle() captures it in a closure so there is no
    // TDZ hazard when spawnImpl throws synchronously (settle would be called
    // before the `const killTimer = …` assignment is reached).
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: BinaryPreflightResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      } as SpawnOptionsWithoutStdio);
    } catch (err) {
      // Synchronous throw from spawn itself (rare, platform-dependent).
      // Treat as unknown rather than missing — we did not get a clean ENOENT.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        settle({ status: 'missing', version: null });
      } else {
        settle({ status: 'unknown', version: null });
      }
      return;
    }

    killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore kill errors */ }
      settle({ status: 'unknown', version: null });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        settle({ status: 'missing', version: null });
      } else {
        settle({ status: 'unknown', version: null });
      }
    });

    child.on('close', () => {
      if (settled) return;
      // Binary executed (even if it exited non-zero) — presence is confirmed.
      const firstLine = stdoutBuffer.split('\n')[0]?.trim() ?? null;
      settle({ status: 'present', version: firstLine || null });
    });
  });
}
