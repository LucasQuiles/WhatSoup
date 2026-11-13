import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireCoordinationLease, defaultLeaseProbes, probeProcessBirthToken, readCoordinationLease, releaseCoordinationLease } from '../../src/transport/coordination-lease.ts';
import { parseAccountScopeId } from '../../src/transport/auth-custody-contracts.ts';

const scopeId = parseAccountScopeId('scope:crash-fixture')!;
const leaseModule = pathToFileURL(join(process.cwd(), 'src/transport/coordination-lease.ts')).href;
let root: string | undefined;
let coordinator: ChildProcess | undefined;
let helper: { pid: number; birth: string } | undefined;

function alive(pid: number) { return defaultLeaseProbes().pidAlive(pid); }

async function stopHelper() {
  if (!helper || !alive(helper.pid)) return;
  if (probeProcessBirthToken(helper.pid) !== helper.birth) throw new Error('fixture helper identity changed; cannot signal it');
  process.kill(helper.pid, 'SIGKILL');
  await vi.waitFor(() => expect(alive(helper!.pid)).toBe(false), { timeout: 3000, interval: 50 });
}

afterEach(async () => {
  try {
    if (coordinator && coordinator.exitCode === null && coordinator.signalCode === null) {
      coordinator.kill('SIGTERM');
      await vi.waitFor(() => expect(coordinator!.signalCode ?? coordinator!.exitCode).not.toBeNull(), { timeout: 3000 });
    }
    await stopHelper();
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    coordinator = undefined;
    helper = undefined;
  }
});

async function launch(allowRegistration: boolean) {
  root = mkdtempSync(join(tmpdir(), 'lease-helper-crash-'));
  if (allowRegistration) writeFileSync(join(root, 'register'), 'go');
  const helperCode = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { defaultLeaseProbes, registerCoordinationLeaseHelper } from ${JSON.stringify(leaseModule)};
    const root = ${JSON.stringify(root)};
    const timer = setInterval(() => {
      if (!existsSync(join(root, 'register'))) return;
      clearInterval(timer);
      const result = registerCoordinationLeaseHelper({ stateRoot: root, scopeId: ${JSON.stringify(scopeId)}, operationId: 'original', fencingToken: 1, parentPid: process.ppid, probes: defaultLeaseProbes() });
      writeFileSync(join(root, 'outcome.json'), JSON.stringify(result));
      if (!result.ok) process.exit(1);
      writeFileSync(join(root, 'credentials-written'), 'owned');
      setInterval(() => {}, 1000);
    }, 10);
  `;
  const coordinatorCode = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { acquireCoordinationLease, defaultLeaseProbes, probeProcessBirthToken } from ${JSON.stringify(leaseModule)};
    const root = ${JSON.stringify(root)};
    const lease = acquireCoordinationLease({ stateRoot: root, scopeId: ${JSON.stringify(scopeId)}, operationId: 'original', mode: 'pairing', ttlMs: 60000, probes: defaultLeaseProbes() });
    if (!lease.ok) process.exit(2);
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(helperCode)}], { stdio: 'ignore' });
    process.once('SIGTERM', () => { child.kill('SIGKILL'); process.exit(0); });
    writeFileSync(join(root, 'helper.json'), JSON.stringify({ pid: child.pid, birth: probeProcessBirthToken(child.pid) }));
    setInterval(() => {}, 1000);
  `;
  coordinator = spawn(process.execPath, ['--input-type=module', '-e', coordinatorCode], { stdio: 'ignore' });
  await vi.waitFor(() => expect(existsSync(join(root!, 'helper.json'))).toBe(true), { timeout: 4000 });
  helper = JSON.parse(readFileSync(join(root, 'helper.json'), 'utf8'));
  expect(helper!.birth).toBeTypeOf('string');
  expect(probeProcessBirthToken(helper!.pid)).toBe(helper!.birth);
}

async function crashCoordinator() {
  coordinator!.kill('SIGKILL');
  await vi.waitFor(() => expect(coordinator!.signalCode).toBe('SIGKILL'), { timeout: 3000 });
}

function acquireNext() {
  return acquireCoordinationLease({ stateRoot: root!, scopeId, operationId: 'replacement', mode: 'pairing', ttlMs: 60_000, probes: defaultLeaseProbes() });
}

describe('native helper custody after coordinator crash', () => {
  it('holds custody while an orphaned credential writer lives and fences the old operation after its exit', async () => {
    await launch(true);
    await vi.waitFor(() => expect(existsSync(join(root!, 'credentials-written'))).toBe(true), { timeout: 4000 });
    const original = readCoordinationLease(root!, scopeId)!;
    expect(original.helper?.pid).toBe(helper!.pid);
    await crashCoordinator();
    expect(acquireNext()).toEqual({ ok: false, refusal: 'held_by_live_owner' });
    expect(releaseCoordinationLease({ stateRoot: root!, scopeId, lease: original })).toEqual({ ok: false, refusal: 'helper_unconfirmed' });
    await stopHelper();
    const replacement = acquireNext();
    expect(replacement).toMatchObject({ ok: true, lease: { fencingToken: 2 } });
    expect(releaseCoordinationLease({ stateRoot: root!, scopeId, lease: original })).toEqual({ ok: false, refusal: 'fencing_token_mismatch' });
    expect(readCoordinationLease(root!, scopeId)?.operationId).toBe('replacement');
  });

  it('refuses a helper that reaches registration after its coordinator was replaced', async () => {
    await launch(false);
    await crashCoordinator();
    expect(acquireNext()).toMatchObject({ ok: true, lease: { fencingToken: 2 } });
    writeFileSync(join(root!, 'register'), 'go');
    await vi.waitFor(() => expect(existsSync(join(root!, 'outcome.json'))).toBe(true), { timeout: 4000 });
    expect(JSON.parse(readFileSync(join(root!, 'outcome.json'), 'utf8'))).toEqual({ ok: false, refusal: 'fencing_token_mismatch' });
    expect(existsSync(join(root!, 'credentials-written'))).toBe(false);
    expect(readCoordinationLease(root!, scopeId)?.operationId).toBe('replacement');
  });
});
