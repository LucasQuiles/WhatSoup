/**
 * QR-090 (fd-pin TOCTOU guard) for the scheduled-media reader.
 *
 * `resolveScheduledFile` validated `filePath` with `realpathSync` + within-root,
 * then re-opened the canonical path BY NAME for `existsSync`/`statSync`/`readFileSync`.
 * A confined per-chat agent (whose `allowedRoot` is its own workspace) can write a
 * real file, call `schedule_message`, and swap the canonical path for a symlink to an
 * out-of-root secret in the window between the check and the read — exfiltrating the
 * secret into the durable `media_blob` that is later sent to the chat (the same
 * lethal-trifecta read-then-send QR-090 fixed in `createMediaReadStream`).
 *
 * The fix opens the path ONCE, then verifies the actually-opened inode (fd) against
 * the canonical path within `allowedRoot` before trusting any bytes, and reads off the
 * pinned fd. Here the "concurrent attacker" is injected deterministically by wrapping
 * a single real fs call at the TOCTOU window; every other fs op (open/read) is real.
 *
 * No real secrets — synthetic temp files only.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Wrap statSync so that the FIRST stat of the "legit" path swaps it for a symlink to
// the out-of-root secret — simulating an attacker winning the race after the caller's
// realpath/within-root check. All other fs behaviour is the real implementation.
let legitPathToSwap: string | null = null;
let secretTarget: string | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrappedStatSync: typeof actual.statSync = ((p: Parameters<typeof actual.statSync>[0], opts?: Parameters<typeof actual.statSync>[1]) => {
    if (legitPathToSwap && secretTarget && String(p) === legitPathToSwap) {
      const target = secretTarget;
      const victim = legitPathToSwap;
      legitPathToSwap = null; // one-shot: simulate the attacker winning the race exactly once
      try { actual.rmSync(victim); } catch { /* ignore */ }
      actual.symlinkSync(target, victim);
    }
    return actual.statSync(p, opts as never);
  }) as typeof actual.statSync;
  return { ...actual, statSync: wrappedStatSync };
});

const { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { resolveScheduledFile } = await import('../../src/core/schedule-enqueue.ts');

describe('resolveScheduledFile fd-pin TOCTOU guard (QR-090)', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sched-toctou-root-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'sched-toctou-secret-')));
    legitPathToSwap = null;
    secretTarget = null;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    legitPathToSwap = null;
    secretTarget = null;
  });

  it('does not leak an out-of-root secret when the path is swapped after the boundary check', () => {
    const legit = join(root, 'legit.pdf');
    writeFileSync(legit, Buffer.from('%PDF-1.4 legitimate-content'));
    const secret = join(outside, 'secret.pdf');
    writeFileSync(secret, Buffer.from('%PDF-1.4 TOP-SECRET-CREDENTIAL'));

    // Arm the swap: the next statSync of `legit` replaces it with a symlink → secret.
    legitPathToSwap = legit;
    secretTarget = secret;

    let leaked = false;
    let threw = false;
    try {
      const { buffer } = resolveScheduledFile(legit, root);
      leaked = buffer.toString().includes('TOP-SECRET');
    } catch {
      threw = true;
    }

    // Fail-closed: either it rejects, or it returns the pinned legit bytes — never the secret.
    expect(leaked).toBe(false);
    expect(threw).toBe(true);
  });

  it('still reads a legitimate in-root file when no swap occurs', () => {
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const f = join(sub, 'nested.pdf');
    writeFileSync(f, Buffer.from('%PDF-1.4 nested-ok'));
    const { buffer } = resolveScheduledFile(f, root);
    expect(buffer.toString()).toContain('nested-ok');
  });
});
