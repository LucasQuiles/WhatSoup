import { chmodSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OLD,
  REPO,
  T,
  TARGET,
  buildNativeFixture,
  cleanupHarnesses,
  events,
  fixtureCalls,
  makeHarness,
  onDarwin,
  pinDir,
  plainInstance,
  portableInstance,
  run,
  systemdUnit,
  writePlist,
  type Harness,
} from './harness-maintenance-fixture-helper.ts';

// Service inventory gaps: every instance, in every supported service-definition form, must be
// counted before the shared launcher is updated, and the install transaction must report what
// actually happened.

beforeAll(buildNativeFixture);
afterAll(cleanupHarnesses);

function statuses(r: ReturnType<typeof run>): string[] {
  return events(r, 'claude').map((e) => e.status);
}

function alerts(h: Harness): string {
  try {
    return readFileSync(h.alertLog, 'utf8');
  } catch {
    return '';
  }
}

/** A release directory whose wrapper and PATH composition are copies of this repo's. */
function release(h: Harness, name: string, identical = true): string {
  const dir = path.join(h.home, 'releases', name);
  mkdirSync(path.join(dir, 'deploy/lib'), { recursive: true });
  copyFileSync(path.join(REPO, 'deploy/whatsoup'), path.join(dir, 'deploy/whatsoup'));
  chmodSync(path.join(dir, 'deploy/whatsoup'), 0o755);
  const composition = readFileSync(path.join(REPO, 'deploy/lib/runtime-path.sh'), 'utf8');
  writeFileSync(path.join(dir, 'deploy/lib/runtime-path.sh'), identical ? composition : `${composition}\n# changed\n`);
  return path.join(dir, 'deploy/whatsoup');
}

describe('launchd instances in the release-wrapper form', () => {
  it.runIf(onDarwin)('holds when an instance runs a release wrapper that cannot be verified, naming it', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    plainInstance(h, 'alpha');
    writePlist(h, 'beta', { PATH: '/usr/bin:/bin', WHATSOUP_NODE: process.execPath, WHATSOUP_PATH_PREPEND: pin },
      [path.join(h.home, 'releases/r1/deploy/whatsoup'), 'beta']);
    const r = run(h);
    const beta = events(r, 'claude-consumer').find((e) => e.message.startsWith('beta'))!;
    expect(beta.status).toBe('unknown');
    expect(events(r, 'claude').at(-1)?.message).toContain('beta');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }, T);

  it.runIf(onDarwin)('resolves a release wrapper identical to this checkout through the same PATH composition', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    plainInstance(h, 'alpha');
    writePlist(h, 'beta', { PATH: '/usr/bin:/bin', WHATSOUP_NODE: process.execPath, WHATSOUP_PATH_PREPEND: pin },
      [release(h, 'r1'), 'beta']);
    const r = run(h);
    expect(events(r, 'claude-consumer').find((e) => e.message.startsWith('beta'))!.message)
      .toContain(`beta via launchd: ${pin}/claude`);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'held' });
    expect(events(r, 'claude').at(-1)!.message).toContain(`beta=${pin}/claude`);
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it.runIf(onDarwin)('treats a release wrapper whose PATH composition differs as unknown', () => {
    const h = makeHarness();
    writePlist(h, 'beta', { PATH: '/usr/bin:/bin', WHATSOUP_NODE: process.execPath }, [release(h, 'r1', false), 'beta']);
    const r = run(h);
    expect(events(r, 'claude-consumer')[0]).toMatchObject({ status: 'unknown' });
    expect(events(r, 'claude-consumer')[0]!.message).toContain('release wrapper');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it.runIf(onDarwin)('still skips a com.whatsoup job that is not an instance', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    writePlist(h, 'harness-maintenance', { PATH: '/usr/bin:/bin' }, ['/bin/bash', '/x/harness-maintenance.sh']);
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    expect(consumer.find((e) => e.message.includes('com.whatsoup.harness-maintenance.plist'))?.status).toBe('skipped');
    expect(consumer.filter((e) => e.status === 'unknown')).toEqual([]);
    expect(events(r, 'claude').at(-1)?.status).toBe('updated');
  }, T);
});

describe('the installed wrapper link', () => {
  /** Point ~/.local/bin/whatsoup at another tree's wrapper, as a release switch does. */
  function relink(h: Harness, wrapper: string): void {
    const link = path.join(h.home, '.local/bin/whatsoup');
    rmSync(link);
    symlinkSync(wrapper, link);
  }

  function expectHeldUnknown(h: Harness, r: ReturnType<typeof run>, wrapper: string): void {
    const alpha = events(r, 'claude-consumer').find((e) => e.message.startsWith('alpha'))!;
    expect(alpha.status).toBe('unknown');
    expect(alpha.message).toContain(wrapper);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'unknown' });
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }

  it.runIf(onDarwin)('verifies the tree the launchd wrapper link points at, not the link', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    const wrapper = release(h, 'r1', false);
    relink(h, wrapper);
    expectHeldUnknown(h, run(h), wrapper);
  }, T);

  it('verifies the tree the systemd wrapper link points at, not the link', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const wrapper = release(h, 'r1', false);
    relink(h, wrapper);
    expectHeldUnknown(h, run(h), wrapper);
  }, T);

  it('reports an absent wrapper link as unknown', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    rmSync(path.join(h.home, '.local/bin/whatsoup'));
    expectHeldUnknown(h, run(h), path.join(h.home, '.local/bin/whatsoup'));
  }, T);

  it('still installs when the wrapper link points at a tree identical to this checkout', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    relink(h, release(h, 'r1'));
    const r = run(h);
    expect(events(r, 'claude-consumer')[0]).toMatchObject({ status: 'resolved' });
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'updated' });
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, TARGET));
  }, T);
});

describe('zero consumers', () => {
  it('alerts instead of holding silently when no service instance was found', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'units'), '');
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude').at(-1)?.status).toBe('held');
    expect(alerts(h)).toMatch(/harness-maintenance:claude-update.*no service instance/);
  }, T);
});

describe('systemd user manager environment', () => {
  it('honours a prepend set in the user manager environment and holds, naming the instance', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    writeFileSync(path.join(h.systemdDir, 'manager.env'), `PATH=/usr/bin:/bin\nWHATSOUP_PATH_PREPEND=${pin}\n`);
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`, 'EnvironmentFiles=']);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude-consumer')[0]!.message).toContain(`alpha via systemd: ${pin}/claude`);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'held' });
    expect(events(r, 'claude').at(-1)!.message).toContain(`alpha=${pin}/claude`);
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('lets the unit environment override the manager environment', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    const empty = path.join(h.home, 'empty-bin');
    mkdirSync(empty, { recursive: true });
    writeFileSync(path.join(h.systemdDir, 'manager.env'), `PATH=/usr/bin:/bin\nWHATSOUP_PATH_PREPEND=${pin}\n`);
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath} WHATSOUP_PATH_PREPEND=${empty}`]);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude-consumer')[0]!.message).toContain(`alpha via systemd: ${h.launcher}`);
  }, T);

  it('reads indented assignments in an environment file, as systemd does', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    const envFile = path.join(h.home, 'alpha.env');
    writeFileSync(envFile, `  WHATSOUP_PATH_PREPEND=${pin}\n`);
    writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`, `EnvironmentFiles=${envFile} (ignore_errors=no)`]);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'held' });
    expect(fixtureCalls(h)).toEqual([]);
  }, T);
});

describe('install transaction reporting', () => {
  it('reports a failed rollback swap as a swap failure, not as a moved launcher, and exits 3', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'lockdir');
    let r;
    try {
      r = run(h);
    } finally {
      chmodSync(path.join(h.home, '.local/bin'), 0o755);
    }
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-failed']);
    const last = events(r, 'claude').at(-1)!.message;
    expect(last).toContain('swap failed');
    expect(last).not.toContain('moved');
    expect(r.status).toBe(3);
  }, T);

  it('fails the postcheck when the launcher changes while --version runs, even if it reports the target', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'swapok');
    const r = run(h);
    expect(statuses(r)).not.toContain('updated');
    expect(statuses(r).slice(0, 2)).toEqual(['install-attempted', 'rollback-attempted']);
    expect(events(r, 'claude').find((e) => e.status === 'rollback-attempted')!.message).toContain('changed while');
    expect(r.status).toBe(3);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, '9.9.9'));
    expect(TARGET).not.toBe('9.9.9');
  }, T);
});
