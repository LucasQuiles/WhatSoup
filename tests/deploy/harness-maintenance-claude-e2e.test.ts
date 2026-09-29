import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OLD,
  RUN_TIMEOUT_MS,
  T,
  TARGET,
  buildNativeFixture,
  cleanupHarnesses,
  customManifest,
  events,
  fixtureCalls,
  makeHarness,
  onDarwin,
  pinDir,
  plainInstance,
  portableInstance,
  run,
  systemdUnit,
  writeExec,
  writePlist,
  type Harness,
  type RunResult,
} from './harness-maintenance-fixture-helper.ts';

// Executes the real maintenance script under /bin/bash in a temporary HOME, with the compiled
// native fixture described in harness-maintenance-fixture-helper.ts.

beforeAll(buildNativeFixture);
afterAll(cleanupHarnesses);

describe('harness-maintenance.sh agent CLI update, end to end', () => {
  it('baseline: the script runs to a final state in a temporary HOME', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    const started = Date.now();
    const r = run(h);
    const elapsed = Date.now() - started;
    expect(r.state, r.stderr).not.toBeNull();
    expect(elapsed).toBeLessThan(RUN_TIMEOUT_MS);
    expect(readlinkSync(h.launcher)).toContain('versions');
  }, RUN_TIMEOUT_MS + 10_000);
});

describe('per-instance service resolver (launchd)', () => {
  it.runIf(onDarwin)('resolves through the plist PATH plus the governed prepend, never the job PATH', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    plainInstance(h, 'alpha', { WHATSOUP_PATH_PREPEND: pin });
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    expect(consumer).toHaveLength(1);
    expect(consumer[0]!.status).toBe('resolved');
    expect(consumer[0]!.message).toContain(`alpha via launchd: ${pin}/claude`);
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it.runIf(onDarwin)('treats a plist without a PATH as unknown instead of borrowing the job PATH', () => {
    const h = makeHarness();
    writePlist(h, 'alpha', { WHATSOUP_NODE: process.execPath });
    const r = run(h);
    expect(events(r, 'claude-consumer').map((e) => e.status)).toEqual(['unknown']);
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(events(r, 'claude').at(-1)?.message).toContain('alpha');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it.runIf(onDarwin)('installs through the shared launcher when every instance resolves it, without executing it first', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    plainInstance(h, 'beta');
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    // Two rounds: the inventory before the install and the postcheck re-resolution after it.
    expect(consumer.map((e) => e.status)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
    for (const e of consumer.slice(0, 2)) expect(e.message).toContain(`${h.launcher} (native ${OLD})`);
    for (const e of consumer.slice(2)) expect(e.message).toContain(`${h.launcher} (native ${TARGET})`);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'updated', before: OLD, target: TARGET });
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, TARGET));
    const calls = fixtureCalls(h);
    const firstInstall = calls.findIndex((line) => line.includes(`install ${TARGET}`));
    expect(firstInstall).toBe(0);
  }, T);

  it.runIf(onDarwin)('records a com.whatsoup plist that is not a generated instance instead of dropping it silently', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    writePlist(h, 'helper', { PATH: '/usr/bin:/bin' }, ['/bin/sh', '-c', 'true']);
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    expect(consumer.find((e) => e.status === 'skipped')?.message).toContain('com.whatsoup.helper.plist');
    expect(consumer.filter((e) => e.status === 'resolved' && e.message.includes(`(native ${OLD})`))).toHaveLength(1);
  }, T);
});

describe('per-instance service resolver (systemd)', () => {
  it('reads PATH and the prepend from the unit environment and its environment files', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    const envFile = path.join(h.home, 'alpha.env');
    writeFileSync(envFile, `# instance tokens\nWHATSOUP_PATH_PREPEND=${pin}\nOTHER_SECRET=do-not-read\n`);
    systemdUnit(h, 'alpha', [
      `Environment=PATH=/usr/bin:/bin WHATSOUP_NODE=${process.execPath}`,
      `EnvironmentFiles=${envFile} (ignore_errors=yes)`,
      `EnvironmentFiles=${path.join(h.home, 'absent.env')} (ignore_errors=yes)`,
    ]);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    const consumer = events(r, 'claude-consumer');
    expect(consumer).toHaveLength(1);
    expect(consumer[0]!.message).toContain(`alpha via systemd: ${pin}/claude`);
    expect(JSON.stringify(r.state)).not.toContain('do-not-read');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('falls back to the user manager PATH only when the unit sets none, and installs', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'manager.env'), 'LANG=C\nPATH=/usr/bin:/bin\n');
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`, 'EnvironmentFiles=']);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude-consumer')[0]!.message).toContain(`alpha via systemd: ${h.launcher}`);
    expect(events(r, 'claude').at(-1)?.status).toBe('updated');
  }, T);

  it('treats an unparseable unit environment as unknown', () => {
    const h = makeHarness();
    systemdUnit(h, 'alpha', ['Environment="PATH=/usr/bin:/bin" "WHATSOUP_NODE=/x y/node"']);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude-consumer')[0]!.status).toBe('unknown');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('treats a failed unit listing as an unknown inventory, not as zero instances', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'list.rc'), '1');
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);
});

describe('shared-binary consumer and pin policy', () => {
  it.runIf(onDarwin)('holds the shared install when any instance is pinned elsewhere, naming it', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    plainInstance(h, 'alpha');
    plainInstance(h, 'beta', { WHATSOUP_PATH_PREPEND: pin });
    const r = run(h);
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('held');
    expect(last.message).toContain('beta');
    expect(last.message).not.toContain('alpha');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it('holds when an instance reaches a native version through a link outside the launcher directory', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const other = path.join(h.home, 'elsewhere/bin');
    mkdirSync(other, { recursive: true, mode: 0o755 });
    symlinkSync(path.join(h.versions, OLD), path.join(other, 'claude'));
    // Only the prepend outranks ~/.local/bin in the launcher's composition.
    systemdUnit(h, 'beta', [`Environment=WHATSOUP_PATH_PREPEND=${other} WHATSOUP_NODE=${process.execPath}`]);
    const r = run(h);
    const beta = events(r, 'claude-consumer').find((e) => e.message.startsWith('beta'))!;
    // It is native, but not the installer-managed launcher, so it is a pin.
    expect(beta.message).toContain(`${other}/claude (native ${OLD})`);
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('held');
    expect(last.message).toContain(`beta=${other}/claude`);
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it.runIf(onDarwin)('holds when one instance is unknown even if the others resolve the launcher', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    writeFileSync(path.join(h.home, 'Library/LaunchAgents/com.whatsoup.beta.plist'), 'not a plist');
    const r = run(h);
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(events(r, 'claude').at(-1)?.message).toContain('beta');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it.runIf(onDarwin)('never updates an unused launcher when no instance consumes it', () => {
    const h = makeHarness();
    const r = run(h);
    expect(events(r, 'claude').at(-1)?.status).toBe('held');
    expect(events(r, 'claude').at(-1)?.message).toContain('no service instance');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it.runIf(onDarwin)('holds a non-native launcher as an unmanaged layout without running an installer', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    rmSync(h.launcher);
    writeExec(h.launcher, `#!/bin/sh\nexec ${path.join(h.versions, OLD)} "$@"\n`);
    const r = run(h);
    expect(events(r, 'claude').at(-1)?.status).toBe('unmanaged-layout');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);
});

describe('bounded step runner and final state', () => {
  it('keeps running independent steps after a failed step and ends degraded with exit 1', () => {
    const h = makeHarness();
    const manifest = path.join(h.home, 'broken-manifest.json');
    writeFileSync(manifest, '{"schema_version": 2}');
    const r = run(h, [], { WHATSOUP_HARNESS_MAINTENANCE_MANIFEST: manifest });
    expect(r.status).toBe(1);
    expect(r.state?.status).toBe('degraded');
    // The probes are independent of the manifest and still ran.
    expect(events(r, 'apt')).toHaveLength(1);
    // Updates depend on a valid manifest and were skipped, not attempted.
    expect(events(r, 'claude')).toEqual([]);
    expect(events(r, 'harness-maintenance').map((e) => e.status)).toContain('skipped');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('ends degraded with exit 1 when an instance binary is unknown', () => {
    const h = makeHarness();
    // No PATH in the unit and none in the manager environment.
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`]);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }, T);

  it('writes a degraded final state and exits 1 when the service binary is missing', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    rmSync(h.launcher);
    const r = run(h);
    expect(events(r, 'claude-consumer')[0]!.status).toBe('missing');
    expect(events(r, 'claude').at(-1)?.status).toBe('missing');
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('records a rejected update plan (exit 2) as held and keeps the job running', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const manifest = customManifest(h, (m) => { m.npm.cooldown_minutes = 10080.5; });
    const r = run(h, [], { WHATSOUP_HARNESS_MAINTENANCE_MANIFEST: manifest });
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('held');
    expect(last.message).toContain('INVALID_ARGUMENT');
    expect(events(r, 'apt')).toHaveLength(1);
    expect(r.state?.status).toBe('degraded');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('bounds the publish-time lookup and holds without installing when it times out', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const started = Date.now();
    const r = run(h, [], { HM_NPM_HANG: '1', WHATSOUP_HARNESS_MAINTENANCE_LOOKUP_TIMEOUT_SECS: '2' });
    expect(Date.now() - started).toBeLessThan(25_000);
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('unknown');
    expect(last.message).toContain('timed out');
    expect(fixtureCalls(h)).toEqual([]);
    expect(r.state?.status).toBe('degraded');
  }, T);

  it('surfaces a final state write failure on its own, with an alert and exit 1', () => {
    const h = makeHarness();
    const stateDir = path.join(h.home, '.cache/whatsoup/harness-maintenance');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    symlinkSync(path.join(h.home, 'elsewhere.json'), path.join(stateDir, 'state.json'));
    const r = run(h);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('state write failed');
    const alerts = readFileSync(h.alertLog, 'utf8').split('\n');
    expect(alerts.some((line) => line.includes('harness-maintenance:job') && line.includes('state write failed'))).toBe(true);
    expect(existsSync(path.join(h.home, 'elsewhere.json'))).toBe(false);
  }, T);
});

function statuses(r: RunResult): string[] {
  return events(r, 'claude').map((e) => e.status);
}

function installCalls(h: Harness): string[] {
  return fixtureCalls(h).filter((line) => / install /.test(line));
}

describe('install and rollback transaction', () => {
  it('installs through the verified previous binary with an explicit target and postchecks the result', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const r = run(h);
    expect(r.status).toBe(0);
    expect(statuses(r)).toEqual(['install-attempted', 'updated']);
    expect(events(r, 'claude')[0]!.message).toContain('rc=0');
    expect(events(r, 'claude')[1]!.message).toMatch(/sha256 [0-9a-f]{64}/);
    // The installer ran from the verified native binary, then only the new binary answered --version.
    expect(fixtureCalls(h)).toEqual([`${OLD} install ${TARGET}`, `${TARGET} --version`]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, TARGET));
  }, T);

  it('rolls back nothing when a failed installer left the link alone, and still exits 1', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'fail');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(events(r, 'claude')[0]!.message).toContain('rc=1');
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }, T);

  it('restores the recorded link when the installer switched it and then failed', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'partial');
    const r = run(h);
    // The requested version is present, but a failed installer is still a failed attempt.
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.status).toBe(1);
  }, T);

  it('reports rollback-failed with exit 3 when the previous binary was pruned, and never reinstalls it', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'prune');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-failed']);
    expect(events(r, 'claude').at(-1)!.message).toContain('previous binary');
    expect(installCalls(h)).toEqual([`${OLD} install ${TARGET}`]);
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(3);
  }, T);

  it('rolls back when the installer exits 0 without switching the link', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'noop');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(r.status).toBe(1);
  }, T);

  it('fails the postcheck when --version prints the target but exits nonzero', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const r = run(h, [], { HM_FIXTURE_VERSION_RC: '1' });
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.status).toBe(1);
  }, T);

  it('bounds a hung installer and rolls back', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'hang');
    const started = Date.now();
    const r = run(h, [], { WHATSOUP_HARNESS_MAINTENANCE_INSTALL_TIMEOUT_SECS: '2' });
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(events(r, 'claude')[0]!.message).toContain('rc=124');
    expect(statuses(r).at(-1)).toBe('rollback-verified');
    expect(r.status).toBe(1);
  }, T);

  it('refuses to swap back a launcher that moved after the install, and exits 3', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'interlope');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-failed']);
    expect(events(r, 'claude').at(-1)!.message).toContain('moved since the install');
    // Left where the other writer put it, not overwritten.
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, '9.9.9'));
    expect(r.status).toBe(3);
  }, T);
});
