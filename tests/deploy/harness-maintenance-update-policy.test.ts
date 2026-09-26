import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAY_MS,
  OLD,
  T,
  TARGET,
  buildNativeFixture,
  cleanupHarnesses,
  events,
  faultScript,
  installNative,
  makeHarness,
  portableInstance,
  run,
  systemdUnit,
  writeExec,
  type Harness,
} from './harness-maintenance-fixture-helper.ts';

// Observation of the agent CLI's own update policy and of launcher movement between runs. The job
// observes and reports; it enforces nothing. Each surface is reported separately: settings on disk,
// the service definition an instance gets at its next launch (or the loaded unit), this job's own
// environment, the live launcher, and running CLI processes (counts only).

beforeAll(buildNativeFixture);
afterAll(cleanupHarnesses);

const UID = process.getuid?.() ?? 0;

/** No service instances under the systemd fake: the update is held, so runs never install. */
function idleHarness(): Harness {
  const h = makeHarness();
  writeFileSync(path.join(h.systemdDir, 'units'), '');
  h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
  return h;
}

function launcherEvents(h: Harness, args: string[] = []) {
  const r = run(h, args);
  return { r, launcher: events(r, 'claude-launcher') };
}

/** Alerts sent under the launcher-movement source. */
function launcherAlerts(h: Harness): number {
  if (!existsSync(h.alertLog)) return 0;
  return readFileSync(h.alertLog, 'utf8').split('\n')
    .filter((line) => line.includes('harness-maintenance:claude-launcher')).length;
}

function repoint(h: Harness, version: string): void {
  installNative(h, version);
  rmSync(h.launcher);
  symlinkSync(path.join(h.versions, version), h.launcher);
}

describe('out-of-band launcher movement', () => {
  it('records a first observation and a baseline for the next run', () => {
    const h = idleHarness();
    const { launcher } = launcherEvents(h);
    expect(launcher.map((e) => e.status)).toEqual(['first-observation', 'baseline']);
    expect(launcher[1]!.after).toContain(`link=${path.join(h.versions, OLD)}`);
    expect(launcher[1]!.after).toMatch(/sha256=[0-9a-f]{64}/);
  }, T);

  it('reports a launcher repointed between runs as moved, with an alert under its own source', () => {
    const h = idleHarness();
    run(h);
    repoint(h, '2.1.281');
    const { r, launcher } = launcherEvents(h);
    expect(launcher[0]).toMatchObject({ status: 'moved' });
    expect(launcher[0]!.before).toContain(`link=${path.join(h.versions, OLD)}`);
    expect(launcher[0]!.after).toContain(`link=${path.join(h.versions, '2.1.281')}`);
    const alerts = readFileSync(h.alertLog, 'utf8');
    expect(alerts).toContain('harness-maintenance:claude-launcher');
    // No instance is known to disable self-updates, so that is named as the probable cause.
    expect(alerts).toContain('probable cause: the agent CLI updating itself');
    // Observation never degrades the run.
    expect(r.state?.status).toBe('ok');
  }, T);

  it('alerts once per distinct launcher target, not again when a move returns to one already reported', () => {
    const h = idleHarness();
    run(h);
    repoint(h, '2.1.281');
    run(h); // OLD -> 2.1.281: new target, alert
    expect(launcherAlerts(h)).toBe(1);
    repoint(h, OLD);
    run(h); // 2.1.281 -> OLD: new target, alert
    expect(launcherAlerts(h)).toBe(2);
    repoint(h, '2.1.281');
    const { launcher } = launcherEvents(h); // back to 2.1.281: already reported
    expect(launcher[0]).toMatchObject({ status: 'moved' });
    expect(launcher[0]!.message).toContain('already alerted');
    expect(launcherAlerts(h)).toBe(2);
  }, T);

  describe('a normal run whose launcher observation did not complete carries the baseline forward', () => {
    const cases: Array<[string, Array<[string, string]>]> = [
      ['the observation step fails', [['observe_claude_update_path() {\n', 'observe_claude_update_path() {\n  false\n']]],
      ['the launcher facts were not captured at the start', [[
        '  if claude_fs facts "$CLAUDE_NATIVE_LAUNCHER" >"$CLAUDE_LAUNCHER_START_FILE.partial" 2>/dev/null; then',
        '  if false; then',
      ]]],
    ];
    for (const [label, edits] of cases) {
      it(`when ${label}`, () => {
        const h = idleHarness();
        run(h);
        const baseline = launcherEvents(h).launcher.find((e) => e.status === 'baseline')!.after;
        repoint(h, '2.1.281');
        const faulty = events(run(h, [], {}, faultScript(h, edits)), 'claude-launcher');
        expect(faulty.find((e) => e.status === 'baseline')?.after).toBe(baseline);
        expect(launcherAlerts(h)).toBe(0);
        // The move is still compared against the carried baseline, and alerted, on the next run.
        expect(launcherEvents(h).launcher[0]).toMatchObject({ status: 'moved' });
        expect(launcherAlerts(h)).toBe(1);
      }, T);
    }

    it('when the run exits before its steps finish', () => {
      const h = idleHarness();
      run(h);
      repoint(h, '2.1.281');
      run(h); // alerted: 2.1.281 is in the alert history, and the baseline
      const kept = launcherEvents(h).launcher;
      const exited = run(h, [], {}, faultScript(h, [['  whatsoup_run_step "$results" manifest guard_manifest\n', '  exit 7\n']]));
      expect(exited.status).toBe(7);
      expect(exited.state?.status).toBe('failed');
      const carried = events(exited, 'claude-launcher');
      expect(carried.find((e) => e.status === 'baseline')?.after).toBe(kept.find((e) => e.status === 'baseline')!.after);
      expect(carried.find((e) => e.status === 'alert-history')?.after).toContain(path.join(h.versions, '2.1.281'));
      expect(launcherEvents(h).launcher[0]).toMatchObject({ status: 'unchanged' });
      expect(launcherAlerts(h)).toBe(1);
    }, T);
  });

  it('names the agent CLI as running during the probes only when the job actually started it', () => {
    const h = idleHarness();
    // A launcher the classifier does not accept, so the listing never starts it, and a probe binary
    // that moves the launcher when the job asks it for its version.
    rmSync(path.join(h.versions, OLD));
    writeExec(path.join(h.versions, OLD), '#!/bin/sh\nexit 0\n');
    installNative(h, '9.9.9');
    writeExec(path.join(h.fakeBin, 'playwright-mcp'),
      `#!/bin/sh\nln -sfn "${path.join(h.versions, '9.9.9')}" "${h.launcher}"\necho 1.0.0\n`);
    const { launcher } = launcherEvents(h);
    const during = launcher.find((e) => e.status === 'moved-during-probes')!;
    expect(during.message).not.toContain('ran the agent CLI');
    const alerts = readFileSync(h.alertLog, 'utf8');
    expect(alerts).toContain('changed during the maintenance job\'s probes');
    expect(alerts).not.toContain('ran the agent CLI');
  }, T);

  it('never follows a symlinked state file for the baseline', () => {
    const h = idleHarness();
    run(h);
    const stateFile = path.join(h.home, '.cache/whatsoup/harness-maintenance/state.json');
    const elsewhere = path.join(h.home, 'elsewhere.json');
    const saved = readFileSync(stateFile, 'utf8');
    writeFileSync(elsewhere, saved);
    rmSync(stateFile);
    symlinkSync(elsewhere, stateFile);
    repoint(h, '2.1.281');
    const r = run(h);
    // The baseline behind the link is not read, so the move is not compared against it ...
    expect(r.stderr).toContain('claude-launcher [first-observation]');
    expect(launcherAlerts(h)).toBe(0);
    // ... and the file behind the link is not overwritten.
    expect(r.stderr).toContain('symlink; refusing to overwrite');
    expect(readFileSync(elsewhere, 'utf8')).toBe(saved);
  }, T);

  it('reports a launcher removed between runs as disappeared', () => {
    const h = idleHarness();
    run(h);
    rmSync(h.launcher);
    const { launcher } = launcherEvents(h);
    expect(launcher[0]).toMatchObject({ status: 'disappeared', after: 'absent' });
  }, T);

  it('does not report the job\'s own install as movement on the next run', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    // A normal run that finds no cooldown-eligible release takes the baseline at OLD without
    // installing; with the publish times restored, the next run installs TARGET itself.
    const times = readFileSync(h.env.HM_NPM_TIME!, 'utf8');
    writeFileSync(h.env.HM_NPM_TIME!, JSON.stringify({
      [OLD]: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      [TARGET]: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    }));
    expect(events(run(h), 'claude').at(-1)?.status).toBe('current');
    writeFileSync(h.env.HM_NPM_TIME!, times);
    const { r: second, launcher } = launcherEvents(h);
    expect(events(second, 'claude').at(-1)?.status).toBe('updated');
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, TARGET));
    // Measured from the launcher as this run found it, so its own install is not movement ...
    expect(launcher[0]).toMatchObject({ status: 'unchanged' });
    // ... and the next baseline already includes it.
    expect(launcher[1]!.after).toContain(`link=${path.join(h.versions, TARGET)}`);
    expect(launcherEvents(h).launcher[0]).toMatchObject({ status: 'unchanged' });
  }, T);

  it('observes movement in check mode too, without alerting', () => {
    const h = idleHarness();
    run(h);
    repoint(h, '2.1.281');
    const { launcher } = launcherEvents(h, ['--check']);
    expect(launcher[0]).toMatchObject({ status: 'moved' });
    expect(launcherAlerts(h)).toBe(0);
  }, T);

  it('keeps the run-mode baseline through a check run, so the next normal run still alerts the move', () => {
    const h = idleHarness();
    run(h);
    repoint(h, '2.1.281');
    run(h, ['--check']);
    const { launcher } = launcherEvents(h);
    expect(launcher[0]).toMatchObject({ status: 'moved' });
    expect(launcherAlerts(h)).toBe(1);
  }, T);

  it('keeps the run-mode baseline through two check runs in a row', () => {
    const h = idleHarness();
    run(h);
    repoint(h, '2.1.281');
    run(h, ['--check']);
    run(h, ['--check']);
    run(h);
    expect(launcherAlerts(h)).toBe(1);
  }, T);

  it('keeps the alerted launcher targets through a check run', () => {
    const h = idleHarness();
    run(h);
    repoint(h, '2.1.281');
    run(h); // alert for 2.1.281
    repoint(h, OLD);
    run(h); // alert for OLD
    repoint(h, '2.1.281');
    run(h, ['--check']);
    const { launcher } = launcherEvents(h); // 2.1.281 was already alerted
    expect(launcher[0]!.message).toContain('already alerted');
    expect(launcherAlerts(h)).toBe(2);
  }, T);

  it('never creates a baseline in check mode', () => {
    const h = idleHarness();
    const { launcher: checked } = launcherEvents(h, ['--check']);
    expect(checked.map((e) => e.status)).toEqual(['first-observation', 'check-observation']);
    expect(launcherEvents(h).launcher[0]).toMatchObject({ status: 'first-observation' });
  }, T);

  it('attributes a launcher move during the job\'s own agent CLI listing to the job, and baselines after it', () => {
    const h = idleHarness();
    writeFileSync(h.modeFile, 'selfupdate');
    const { launcher } = launcherEvents(h);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, '9.9.9'));
    const during = launcher.find((e) => e.status === 'moved-during-probes')!;
    expect(during.before).toContain(`link=${path.join(h.versions, OLD)}`);
    expect(during.after).toContain(`link=${path.join(h.versions, '9.9.9')}`);
    expect(launcher.filter((e) => e.status === 'baseline').at(-1)!.after)
      .toContain(`link=${path.join(h.versions, '9.9.9')}`);
    const alerts = readFileSync(h.alertLog, 'utf8');
    expect(alerts).toContain('changed while the maintenance job ran the agent CLI');
    expect(alerts).not.toContain('outside the maintenance job');
    expect(launcherAlerts(h)).toBe(1);
    // The next run finds the launcher where this run left it: no between-runs move is reported.
    writeFileSync(h.modeFile, 'ok');
    expect(launcherEvents(h).launcher[0]).toMatchObject({ status: 'unchanged' });
    expect(launcherAlerts(h)).toBe(1);
  }, T);
});

describe('agent CLI update policy surfaces', () => {
  function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  }

  it('reports settings on disk, each instance\'s service environment and this job\'s environment separately', () => {
    const h = makeHarness();
    const alt = path.join(h.home, 'alt-config');
    writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
    // alpha: DISABLE_UPDATES in its unit. beta: only DISABLE_AUTOUPDATER. gamma: a relocated
    // config directory whose settings set DISABLE_UPDATES.
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath} DISABLE_UPDATES=1`]);
    systemdUnit(h, 'beta', [`Environment=WHATSOUP_NODE=${process.execPath} DISABLE_AUTOUPDATER=1`]);
    systemdUnit(h, 'gamma', [`Environment=WHATSOUP_NODE=${process.execPath} CLAUDE_CONFIG_DIR=${alt}`]);
    h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
    writeJson(path.join(h.home, '.claude/settings.json'), { env: { DISABLE_AUTOUPDATER: '1' } });
    writeJson(path.join(h.home, '.claude.json'), {
      installMethod: 'npm-global',
      autoUpdates: true,
      oauthAccount: { emailAddress: 'secret-marker@example.invalid' },
      projects: { '/private/project/secret-marker': {} },
    });
    writeJson(path.join(alt, 'settings.json'), { env: { DISABLE_UPDATES: '1' } });
    writeJson(path.join(alt, '.claude.json'), { installMethod: 'native', autoUpdates: false });

    const r = run(h, ['--check'], { DISABLE_AUTOUPDATER: '1' });
    const policy = events(r, 'claude-update-policy');
    const instance = (name: string) => policy.find((e) => e.status === 'instance' && e.message.startsWith(`${name} `))!;

    expect(instance('alpha').message).toContain('alpha via systemd (loaded unit): DISABLE_UPDATES=set DISABLE_AUTOUPDATER=unset');
    expect(instance('alpha').message).toContain('config default');
    expect(instance('alpha').message).toContain('installMethod=npm-global autoUpdates=true');
    expect(instance('alpha').message).toContain('settings env DISABLE_UPDATES=unset DISABLE_AUTOUPDATER=set');
    expect(instance('beta').message).toContain('(loaded unit): DISABLE_UPDATES=unset DISABLE_AUTOUPDATER=set');
    expect(instance('gamma').message).toContain('config set by the service');
    expect(instance('gamma').message).toContain('installMethod=native autoUpdates=false');
    expect(instance('gamma').message).toContain('settings env DISABLE_UPDATES=set');

    expect(policy.find((e) => e.status === 'job-env')!.message)
      .toBe('this job: DISABLE_UPDATES=unset DISABLE_AUTOUPDATER=set CLAUDE_CONFIG_DIR=unset');
    // alpha (unit) and gamma (settings) have DISABLE_UPDATES; beta's DISABLE_AUTOUPDATER is not counted.
    const summary = policy.at(-1)!;
    expect(summary.status).toBe('advisory');
    expect(summary.message).toContain('2 of 3 instances');
    expect(summary.message).toContain('beta');

    // Only the allowlisted keys are read from the global config file.
    expect(JSON.stringify(r.state)).not.toContain('secret-marker');
  }, T);

  it.runIf(process.platform === 'darwin')('labels a launchd plist on disk as the next launch', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.home, 'Library/LaunchAgents/com.whatsoup.alpha.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>com.whatsoup.alpha</string>',
      '<key>ProgramArguments</key><array>',
      `<string>${path.join(h.home, '.local/bin/whatsoup')}</string><string>alpha</string></array>`,
      '<key>EnvironmentVariables</key><dict>',
      '<key>PATH</key><string>/usr/bin:/bin</string>',
      `<key>WHATSOUP_NODE</key><string>${process.execPath}</string>`,
      '<key>DISABLE_UPDATES</key><string>1</string>',
      '</dict></dict></plist>',
      '',
    ].join('\n'));
    const r = run(h, ['--check']);
    const policy = events(r, 'claude-update-policy');
    expect(policy.find((e) => e.status === 'instance')!.message)
      .toContain('alpha via launchd (next launch; loaded job environment not read): DISABLE_UPDATES=set');
    expect(policy.at(-1)).toMatchObject({ status: 'disabled' });
  }, T);

  it('counts only truthy values as disabling updates; any other value is unrecognized and unknown', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath} DISABLE_UPDATES=TRUE`]);
    systemdUnit(h, 'beta', [`Environment=WHATSOUP_NODE=${process.execPath} DISABLE_UPDATES=0 DISABLE_AUTOUPDATER=`]);
    h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
    writeJson(path.join(h.home, '.claude/settings.json'), { env: { DISABLE_AUTOUPDATER: 'false' } });
    const r = run(h, ['--check'], { DISABLE_UPDATES: '0' });
    const policy = events(r, 'claude-update-policy');
    const instance = (name: string) => policy.find((e) => e.status === 'instance' && e.message.startsWith(`${name} `))!;
    expect(instance('alpha').message).toContain('DISABLE_UPDATES=set DISABLE_AUTOUPDATER=unset');
    expect(instance('beta').message).toContain('DISABLE_UPDATES=set-unrecognized DISABLE_AUTOUPDATER=set-unrecognized');
    expect(instance('alpha').message).toContain('settings env DISABLE_UPDATES=unset DISABLE_AUTOUPDATER=set-unrecognized');
    expect(policy.find((e) => e.status === 'job-env')!.message).toContain('DISABLE_UPDATES=set-unrecognized');
    const summary = policy.at(-1)!;
    expect(summary.status).toBe('unknown');
    expect(summary.message).toContain('beta');
    expect(summary.message).not.toContain('alpha');
  }, T);

  it('reads settings.local.json over settings.json, and managed settings over both', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeJson(path.join(h.home, '.claude/settings.json'), { env: { DISABLE_UPDATES: '0' } });
    writeJson(path.join(h.home, '.claude/settings.local.json'), { env: { DISABLE_UPDATES: 'true' } });
    const local = events(run(h, ['--check']), 'claude-update-policy');
    expect(local.find((e) => e.status === 'instance')!.message)
      .toContain('settings env DISABLE_UPDATES=set DISABLE_AUTOUPDATER=unset; settings files: settings.local.json+settings.json');
    expect(local.at(-1)).toMatchObject({ status: 'disabled' });

    // Managed settings apply to every config directory and take precedence.
    const managed = path.join(h.home, 'managed-settings.json');
    writeJson(managed, { env: { DISABLE_UPDATES: '0' } });
    const overridden = events(run(h, ['--check'], { WHATSOUP_HARNESS_MANAGED_SETTINGS_FILE: managed }), 'claude-update-policy');
    expect(overridden.find((e) => e.status === 'instance')!.message)
      .toContain('settings env DISABLE_UPDATES=set-unrecognized DISABLE_AUTOUPDATER=unset; settings files: managed+settings.local.json+settings.json');
    expect(overridden.at(-1)).toMatchObject({ status: 'unknown' });
  }, T);

  it('reports settings that cannot be parsed as unreadable, never as unset', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    mkdirSync(path.join(h.home, '.claude'), { recursive: true });
    writeFileSync(path.join(h.home, '.claude/settings.json'), '{not json');
    writeFileSync(path.join(h.home, '.claude.json'), '[1,2]');
    const policy = events(run(h, ['--check']), 'claude-update-policy');
    const instance = policy.find((e) => e.status === 'instance')!;
    expect(instance.message).toContain('settings env DISABLE_UPDATES=unreadable DISABLE_AUTOUPDATER=unreadable');
    // An array is readable JSON but not a config object: its keys read as absent.
    expect(instance.message).toContain('installMethod=absent autoUpdates=absent');
    expect(policy.at(-1)).toMatchObject({ status: 'unknown' });
  }, T);

  it('reports an unknown policy, not an empty one, when the service manager cannot be listed', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(path.join(h.systemdDir, 'list.rc'), '1');
    const r = run(h, ['--check']);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'unknown' });
    const summary = events(r, 'claude-update-policy').at(-1)!;
    expect(summary.status).toBe('unknown');
    expect(summary.message).toContain('service definitions were not read');
  }, T);

  it('reads a quoted or expanded value in an observed key without making the unit unreadable', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
    const envFile = path.join(h.home, 'unit.env');
    // systemd would unquote and expand these; the reader records them as set but unrecognized, or
    // as a config directory it cannot read, and still resolves the instance's binary.
    writeFileSync(envFile, 'DISABLE_UPDATES="1"\nDISABLE_AUTOUPDATER=$FLAG\nCLAUDE_CONFIG_DIR=$HOME/alt\n');
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`, `EnvironmentFiles=${envFile} (ignore_errors=no)`]);
    h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
    const r = run(h, ['--check']);
    expect(events(r, 'claude-consumer')[0]).toMatchObject({ status: 'resolved' });
    const instance = events(r, 'claude-update-policy').find((e) => e.status === 'instance')!;
    expect(instance.message).toContain('DISABLE_UPDATES=set-unrecognized DISABLE_AUTOUPDATER=set-unrecognized');
    expect(instance.message).toContain('config set by the service, not readable');
  }, T);

  it('reports an unknown policy when the service definitions were not read this run', () => {
    const h = idleHarness();
    const manifest = path.join(h.home, 'broken-manifest.json');
    writeFileSync(manifest, '{"schema_version": 2}');
    const r = run(h, ['--check'], { WHATSOUP_HARNESS_MAINTENANCE_MANIFEST: manifest });
    expect(events(r, 'claude-update-policy').at(-1)).toMatchObject({ status: 'unknown' });
  }, T);
});

describe('running agent CLI processes', () => {
  it('counts this user\'s CLI processes and the long-lived ones without recording any command line', () => {
    const h = idleHarness();
    writeExec(path.join(h.fakeBin, 'ps'), [
      '#!/bin/sh',
      'cat <<EOF',
      `  ${UID}  1-02:03:04 /opt/marker-path/claude`,
      `  ${UID}       05:00 claude`,
      `  ${UID}    00:45:10 ${path.join(h.versions, OLD)}`,
      `  ${UID + 1} 3-00:00:00 claude`,
      `  ${UID}    09:00:00 /usr/bin/node`,
      'EOF',
      '',
    ].join('\n'));
    const r = run(h, ['--check']);
    const processes = events(r, 'claude-processes');
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({
      status: 'observed',
      message: '3 agent CLI processes for this user, 2 running longer than 30 minutes (native layout; counts only)',
    });
    expect(JSON.stringify(r.state)).not.toContain('marker-path');
  }, T);
});
