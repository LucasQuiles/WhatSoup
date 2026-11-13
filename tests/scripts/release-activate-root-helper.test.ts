/**
 * The root plist helper as `release:activate --apply` uses it (owner ruling R45):
 * a fixed root-owned install whose digest is pinned in root-helper.json, run as
 * exactly `sudo -n /usr/bin/python3 -I -S -B <pinned path>`, with a missing or
 * outdated install refused before any live change, and any helper result but
 * exit 0 or exit 2 (exit 3, a signal, a timeout, another code) reported as
 * unconfirmed protection.
 *
 * Tests cannot create root-owned files, so lstat reports one staged plist as
 * root-owned and a fake sudo stands in for the helper.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyActivation } from '../../scripts/lib/release-activation/apply.ts';
import type { ActivationHost, ExecResult } from '../../scripts/lib/release-activation/host.ts';
import { buildActivationContext } from '../../scripts/lib/release-activation/plan.ts';
import {
  readInstalledRootHelper,
  readRootHelperPin,
  ROOT_HELPER_OUTDATED,
  ROOT_HELPER_SUDO,
  rootHelperArgs,
  rootHelperFailure,
} from '../../scripts/lib/release-activation/root-helper-interpreter.ts';
import { parseActivationArgs } from '../../scripts/release-activate.ts';
import {
  activationArgs,
  type Fixture,
  installFixture,
  INSTANCE,
  SimulatedLaunchd,
  TIMER_LABEL,
} from '../helpers/release-activate-world.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = vi.fn(actual.lstatSync);
  return { ...actual, default: { ...actual, lstatSync }, lstatSync };
});

vi.mock('../../scripts/lib/release-activation/root-helper-interpreter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/release-activation/root-helper-interpreter.ts')>();
  return { ...actual, readInstalledRootHelper: vi.fn(() => null) };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const HELPER_SOURCE = fileURLToPath(new URL('../../scripts/lib/release-activation/protected_plist.py', import.meta.url));
const helperBytes = (): Buffer => actualFs.readFileSync(HELPER_SOURCE);
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('root plist helper pin and invocation', () => {
  it('pins the sha256 of protected_plist.py at a fixed PrivilegedHelperTools path', () => {
    const pin = readRootHelperPin();
    expect(Object.keys(pin).sort()).toEqual(['path', 'sha256']);
    // Repin root-helper.json in the same commit as any helper change.
    expect(pin.sha256).toBe(sha256(helperBytes()));
    expect(pin.path).toMatch(/^\/Library\/PrivilegedHelperTools\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('runs exactly sudo -n /usr/bin/python3 -I -S -B <pinned path>', () => {
    const pin = readRootHelperPin();
    expect([ROOT_HELPER_SUDO, ...rootHelperArgs(pin)]).toEqual(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '-S', '-B', pin.path]);
  });

  it('accepts only an installed helper with the pinned bytes', () => {
    const pin = readRootHelperPin();
    expect(rootHelperFailure(pin, null)).toBe(ROOT_HELPER_OUTDATED);
    expect(rootHelperFailure(pin, Buffer.from('# an older helper\n'))).toBe(ROOT_HELPER_OUTDATED);
    expect(rootHelperFailure(pin, helperBytes())).toBeNull();
    expect(ROOT_HELPER_OUTDATED).toMatch(/missing or outdated; run the install step/);
  });
});

let fixture: Fixture;

beforeEach(() => {
  fixture = installFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(fs.lstatSync).mockImplementation(actualFs.lstatSync);
  vi.mocked(readInstalledRootHelper).mockReturnValue(null);
});

const timerPlist = (): string => path.join(fixture.launchAgents, `${TIMER_LABEL}.plist`);

/** lstat reports `target` as root-owned; every other path is unchanged. */
function reportRootOwned(target: string): void {
  vi.mocked(fs.lstatSync).mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
    const stats = actualFs.lstatSync(file, options);
    if (stats === undefined || String(file) !== target) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as fs.Stats, stats, { uid: 0 });
  }) as typeof fs.lstatSync);
}

/** One fake helper run: its result, and whether it wrote the requested contents first. A bare number writes. */
type HelperReply = number | { code: number; write: boolean; timedOut?: true };

/** The simulated host, with `/usr/bin/sudo` answered by `sudo` (which writes the requested contents, as the helper would). */
function withFakeSudo(world: SimulatedLaunchd, replies: HelperReply[]): { host: ActivationHost; calls: Array<{ args: readonly string[]; request: Record<string, unknown> }> } {
  const base = world.host();
  const calls: Array<{ args: readonly string[]; request: Record<string, unknown> }> = [];
  const host: ActivationHost = {
    ...base,
    exec: async (file, args, options): Promise<ExecResult> => {
      if (file !== ROOT_HELPER_SUDO) return base.exec(file, args, options);
      const request = JSON.parse(options?.input ?? '{}') as Record<string, unknown>;
      calls.push({ args, request });
      const raw = replies[calls.length - 1] ?? 0;
      const reply = typeof raw === 'number' ? { code: raw, write: true } : raw;
      if (reply.write) writeFileSync(String(request['path']), String(request['contents']));
      return { code: reply.code, stdout: '', stderr: '', ...(reply.timedOut === true ? { timedOut: true as const } : {}) };
    },
  };
  return { host, calls };
}

async function applyWithRootOwnedTimer(replies: HelperReply[]) {
  reportRootOwned(timerPlist());
  const world = new SimulatedLaunchd(fixture);
  const { host, calls } = withFakeSudo(world, replies);
  const context = await buildActivationContext(host, parseActivationArgs(activationArgs(fixture, ['--apply'])));
  expect(context.preconditions.filter((entry) => !entry.ok)).toEqual([]);
  const linkBefore = readlinkSync(context.wrapperLink);
  const original = readFileSync(timerPlist(), 'utf8');
  const outcome = await applyActivation(host, context);
  return { outcome, calls, context, linkBefore, original };
}

describe('release:activate --apply with a root-owned plist', () => {
  it('refuses before any live change when the helper is missing or outdated', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(Buffer.from('# an older helper\n'));
    const { outcome, calls, context, linkBefore, original } = await applyWithRootOwnedTimer([]);

    expect(outcome.outcome).toBe('refused');
    expect(outcome.failure).toBe(ROOT_HELPER_OUTDATED);
    expect(outcome.steps.at(-1)).toEqual({ step: 'check-root-plist-helper', ok: false, detail: ROOT_HELPER_OUTDATED });
    expect(calls).toEqual([]);
    expect(readlinkSync(context.wrapperLink)).toBe(linkBefore);
    expect(readFileSync(timerPlist(), 'utf8')).toBe(original);
  });

  it('replaces the plist through the pinned helper invocation when the install is current', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(helperBytes());
    const { outcome, calls, original } = await applyWithRootOwnedTimer([0]);

    expect(outcome.outcome).toBe('activated');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['-n', '/usr/bin/python3', '-I', '-S', '-B', readRootHelperPin().path]);
    expect(calls[0]!.request).toMatchObject({ path: timerPlist(), expectedSha256: sha256(original), metadata: { uid: 0 } });
    expect(vi.mocked(readInstalledRootHelper)).toHaveBeenCalledWith(readRootHelperPin().path);
  });

  it('fails the activation, never succeeds, when the helper reports incomplete recovery (exit 3)', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(helperBytes());
    // The helper wrote the new bytes but could not confirm protection; the restore then runs. The restore
    // puts back the bytes, but nothing here can read the uchg flag, so the rollback stays unverified.
    const { outcome, calls, original } = await applyWithRootOwnedTimer([3, 0]);

    expect(outcome.outcome).not.toBe('activated');
    expect(outcome.outcome).toBe('rollback-unverified');
    expect(outcome.failure).toMatch(/com\.whatsoup\.aux-timer\.plist: root plist helper recovery is incomplete/);
    expect(outcome.failure).toMatch(/inspect the plist and its uchg flag before any retry/);
    expect(outcome.rollback?.verified).toBe(false);
    expect(outcome.rollback?.steps.at(-1)).toMatchObject({ step: 'confirm-plist-protection', ok: false });
    expect(calls).toHaveLength(2);
    expect(readFileSync(timerPlist(), 'utf8')).toBe(original);
  });

  // Opus I-1: only exit 0 with the new bytes and exit 2 (failed as found) say where protection stands.
  // A signal, a timeout or any other code can stop the helper after it cleared uchg.

  it('treats a helper killed by a signal before its rename as unconfirmed protection (Opus r2)', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(helperBytes());
    // The original bytes stay, so the rollback skips the write; protection is still unknown.
    const { outcome, calls, original } = await applyWithRootOwnedTimer([{ code: 127, write: false }]);

    expect(outcome.outcome).toBe('rollback-unverified');
    expect(outcome.failure).toMatch(/com\.whatsoup\.aux-timer\.plist: root plist helper ended without confirming protection \(exit 127\)/);
    expect(outcome.failure).toMatch(/inspect the plist and its uchg flag before any retry/);
    expect(outcome.rollback?.verified).toBe(false);
    expect(outcome.rollback?.steps.at(-1)).toMatchObject({ step: 'confirm-plist-protection', ok: false });
    expect(calls).toHaveLength(1);
    expect(readFileSync(timerPlist(), 'utf8')).toBe(original);
  });

  it('treats a helper timeout as unconfirmed protection', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(helperBytes());
    const { outcome, calls } = await applyWithRootOwnedTimer([{ code: 127, write: false, timedOut: true }]);

    expect(outcome.outcome).toBe('rollback-unverified');
    expect(outcome.failure).toMatch(/root plist helper timed out without confirming protection/);
    expect(outcome.rollback?.verified).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('treats an unknown helper exit code as unconfirmed protection', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(helperBytes());
    // Exit 1 is also sudo's own failure, for example when the rule is missing.
    const { outcome, calls, original } = await applyWithRootOwnedTimer([{ code: 1, write: true }, 0]);

    expect(outcome.outcome).toBe('rollback-unverified');
    expect(outcome.failure).toMatch(/root plist helper ended without confirming protection \(exit 1\)/);
    expect(outcome.rollback?.verified).toBe(false);
    expect(outcome.rollback?.steps.at(-1)).toMatchObject({ step: 'confirm-plist-protection', ok: false });
    expect(calls).toHaveLength(2);
    expect(readFileSync(timerPlist(), 'utf8')).toBe(original);
  });

  it('still verifies the rollback when the helper failed with the plist as found (exit 2)', async () => {
    vi.mocked(readInstalledRootHelper).mockReturnValue(helperBytes());
    const { outcome, calls, original } = await applyWithRootOwnedTimer([{ code: 2, write: false }]);

    expect(outcome.outcome).toBe('rolled-back');
    expect(outcome.failure).toBe('protected plist replacement failed; inspect activation rollback receipt');
    expect(outcome.rollback?.verified).toBe(true);
    expect(outcome.rollback?.steps.map((entry) => entry.step)).not.toContain('confirm-plist-protection');
    expect(calls).toHaveLength(1);
    expect(readFileSync(timerPlist(), 'utf8')).toBe(original);
  });
});
