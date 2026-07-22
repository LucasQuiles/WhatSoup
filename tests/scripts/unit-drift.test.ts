import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/check-unit-drift.sh');
const tmpDirs: string[] = [];

function makeFixture(): { repo: string; systemd: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-unit-drift-'));
  tmpDirs.push(root);
  const repo = join(root, 'repo');
  const systemd = join(root, 'systemd');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(join(repo, 'deploy/scripts'), { recursive: true });
  mkdirSync(systemd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeEnsureNode(repo, bin, true);
  chmodSync(SCRIPT, 0o755);
  return { repo, systemd, bin };
}

function ensureNodeBody(hasFastPath: boolean): string {
  return hasFastPath
    ? [
      '#!/usr/bin/env bash',
      'LOCAL_NODE="$HOME/.nvm/versions/node/v24.15.0/bin/node"',
      'if [ -x "$LOCAL_NODE" ]; then',
      '  echo "ensure-node-installed: v24.15.0 already present at $LOCAL_NODE; skipping nvm install" >&2',
      '  exit 0',
      'fi',
      '',
    ].join('\n')
    : [
      '#!/usr/bin/env bash',
      'nvm install 24.15.0 --no-progress',
      '',
    ].join('\n');
}

function writeEnsureNode(repo: string, bin: string, hasFastPath: boolean): void {
  writeEnsureNodePair(repo, bin, hasFastPath, hasFastPath);
}

function writeEnsureNodePair(
  repo: string,
  bin: string,
  repoHasFastPath: boolean,
  installedHasFastPath: boolean,
): void {
  const repoScript = join(repo, 'deploy/scripts/ensure-node-installed.sh');
  const installed = join(bin, 'whatsoup-ensure-node');
  writeFileSync(repoScript, ensureNodeBody(repoHasFastPath));
  writeFileSync(installed, ensureNodeBody(installedHasFastPath));
  chmodSync(repoScript, 0o755);
  chmodSync(installed, 0o755);
}

function run(args: string[]) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
  });
}

const MONITOR_UNITS = [
  'bot-errors-tree-provenance.service',
  'bot-errors-tree-provenance.timer',
  'bot-errors-runtime-staleness.service',
  'bot-errors-runtime-staleness.timer',
];

function writeMonitorUnits(repo: string, systemd: string): void {
  for (const unit of MONITOR_UNITS) {
    const body = `[Unit]\nDescription=${unit}\n`;
    writeFileSync(join(repo, 'deploy', unit), body);
    writeFileSync(join(systemd, unit), body);
  }
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('check-unit-drift.sh', () => {
  it('passes when the checked-in and installed unit match', () => {
    const { repo, systemd, bin } = makeFixture();
    const content = '[Unit]\nDescription=Match\n';
    writeFileSync(join(repo, 'deploy/example.service'), content);
    writeFileSync(join(systemd, 'example.service'), content);

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'example.service',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: example.service');
    expect(result.stdout).toContain('all managed systemd units match');
  });

  it('fails and prints a diff when an installed unit has drifted', () => {
    const { repo, systemd, bin } = makeFixture();
    writeFileSync(join(repo, 'deploy/example.service'), '[Unit]\nDescription=Repo\n');
    writeFileSync(join(systemd, 'example.service'), '[Unit]\nDescription=Live\n');

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'example.service',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drift: example.service');
    expect(result.stderr).toContain('-Description=Repo');
    expect(result.stderr).toContain('+Description=Live');
  });

  it('fails when a managed unit is not installed', () => {
    const { repo, systemd, bin } = makeFixture();
    writeFileSync(join(repo, 'deploy/example.service'), '[Unit]\nDescription=Repo\n');

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'example.service',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing installed unit: example.service');
  });

  it('exits 3 with SKIP: prefix when the systemd user directory is absent', () => {
    const { repo, systemd } = makeFixture();
    const missingSystemd = join(systemd, 'missing');
    writeFileSync(join(repo, 'deploy/example.service'), '[Unit]\nDescription=Repo\n');

    const result = run(['--repo-root', repo, '--systemd-dir', missingSystemd, '--unit', 'example.service']);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('SKIP:');
    expect(result.stdout).toContain('systemd unit directory not found');
  });

  it('exits 0 with SKIP: prefix when the systemd directory is absent and --allow-missing-systemd-dir is passed', () => {
    const { repo, systemd } = makeFixture();
    const missingSystemd = join(systemd, 'missing');
    writeFileSync(join(repo, 'deploy/example.service'), '[Unit]\nDescription=Repo\n');

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', missingSystemd,
      '--allow-missing-systemd-dir',
      '--unit', 'example.service',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP:');
    expect(result.stdout).toContain('systemd unit directory not found');
  });

  it('fails when the installed whatsoup-ensure-node wrapper lacks the local-node fast path', () => {
    const { repo, systemd, bin } = makeFixture();
    const content = '[Unit]\nDescription=Match\n';
    writeFileSync(join(repo, 'deploy/example.service'), content);
    writeFileSync(join(systemd, 'example.service'), content);
    writeEnsureNodePair(repo, bin, true, false);

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'example.service',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('whatsoup-ensure-node');
    expect(result.stderr).toContain('local-Node fast path');
  });

  it('rejects an empty --unit selector instead of erasing unit scope', () => {
    const { repo, systemd, bin } = makeFixture();

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing --unit value');
    expect(result.stderr).not.toContain('unbound variable');
    expect(result.stdout).not.toContain('all managed systemd units match');
  });

  it('rejects an empty --wrapper selector instead of erasing wrapper scope', () => {
    const { repo, systemd, bin } = makeFixture();
    const content = '[Unit]\nDescription=Match\n';
    writeFileSync(join(repo, 'deploy/example.service'), content);
    writeFileSync(join(systemd, 'example.service'), content);

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'example.service',
      '--wrapper',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing --wrapper value');
    expect(result.stderr).not.toContain('unbound variable');
    expect(result.stdout).not.toContain('all managed systemd units match');
  });

  it('preserves an explicit non-empty wrapper selector', () => {
    const { repo, systemd, bin } = makeFixture();
    const content = '[Unit]\nDescription=Match\n';
    writeFileSync(join(repo, 'deploy/example.service'), content);
    writeFileSync(join(systemd, 'example.service'), content);

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'example.service',
      '--wrapper', 'whatsoup-ensure-node:deploy/scripts/ensure-node-installed.sh',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: example.service');
    expect(result.stdout).toContain('ok: whatsoup-ensure-node local-Node fast path present');
    expect(result.stdout).toContain('all managed systemd units match');
  });

  it('rejects combining --no-wrappers with an explicit wrapper selector', () => {
    const { repo, systemd, bin } = makeFixture();

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--no-wrappers',
      '--wrapper', 'whatsoup-ensure-node:deploy/scripts/ensure-node-installed.sh',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--no-wrappers cannot be combined with --wrapper');
    expect(result.stdout).not.toContain('all managed systemd units match');
  });

  it('rejects combining an explicit wrapper selector with --no-wrappers', () => {
    const { repo, systemd, bin } = makeFixture();

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--wrapper', 'whatsoup-ensure-node:deploy/scripts/ensure-node-installed.sh',
      '--no-wrappers',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--no-wrappers cannot be combined with --wrapper');
    expect(result.stdout).not.toContain('all managed systemd units match');
  });

  it('rejects repeated --unit selectors instead of replacing earlier scope', () => {
    const { repo, systemd, bin } = makeFixture();

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', 'first.service',
      '--unit', 'second.service',
      '--no-wrappers',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--unit cannot be repeated');
    expect(result.stdout).not.toContain('all selected systemd units match');
  });

  it('rejects repeated --wrapper selectors instead of replacing earlier scope', () => {
    const { repo, systemd, bin } = makeFixture();

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--wrapper', 'first:deploy/scripts/ensure-node-installed.sh',
      '--wrapper', 'second:deploy/scripts/ensure-node-installed.sh',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--wrapper cannot be repeated');
    expect(result.stdout).not.toContain('all managed systemd units match');
  });

  it('rejects repeated --no-wrappers selectors', () => {
    const { repo, systemd, bin } = makeFixture();

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--no-wrappers',
      '--no-wrappers',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--no-wrappers cannot be repeated');
    expect(result.stdout).not.toContain('all selected systemd units match');
  });

  it('rejects --no-wrappers when a selected unit references a managed wrapper', () => {
    const { repo, systemd, bin } = makeFixture();
    const unit = 'whatsoup@.service';
    const content = [
      '[Service]',
      'ExecStartPre=%h/.local/bin/whatsoup-ensure-node --version v24.15.0',
      '',
    ].join('\n');
    writeFileSync(join(repo, 'deploy', unit), content);
    writeFileSync(join(systemd, unit), content);
    rmSync(join(bin, 'whatsoup-ensure-node'));

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', unit,
      '--no-wrappers',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--no-wrappers is not applicable');
    expect(result.stderr).toContain(unit);
    expect(result.stderr).toContain('whatsoup-ensure-node');
    expect(result.stdout).not.toContain('wrapper checks: not applicable');
    expect(result.stdout).not.toContain('all selected systemd units match');
  });

  it('rejects --no-wrappers when a selected unit invokes a registered wrapper implementation', () => {
    const { repo, systemd, bin } = makeFixture();
    const unit = 'direct-wrapper.service';
    const implementation = join(repo, 'deploy/scripts/ensure-node-installed.sh');
    const content = `[Service]\nExecStartPre=${implementation}\n`;
    writeFileSync(join(repo, 'deploy', unit), content);
    writeFileSync(join(systemd, unit), content);
    rmSync(join(bin, 'whatsoup-ensure-node'));

    const result = run([
      '--repo-root', repo,
      '--systemd-dir', systemd,
      '--bin-dir', bin,
      '--unit', unit,
      '--no-wrappers',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--no-wrappers is not applicable');
    expect(result.stderr).toContain(unit);
    expect(result.stderr).toContain('deploy/scripts/ensure-node-installed.sh');
    expect(result.stdout).not.toContain('wrapper checks: not applicable');
    expect(result.stdout).not.toContain('all selected systemd units match');
  });
});

describe('release-proof explicit unit scope', () => {
  it('passes when all four monitor units match', () => {
    const { repo, systemd, bin } = makeFixture();
    writeMonitorUnits(repo, systemd);
    const res = run([
      '--repo-root', repo, '--systemd-dir', systemd, '--bin-dir', bin,
      '--unit', ...MONITOR_UNITS,
      '--no-wrappers',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('unbound variable');
    expect(res.stdout).toContain('wrapper checks: not applicable (--no-wrappers)');
    expect(res.stdout).toContain('all selected systemd units match; wrapper checks not applicable');
    for (const unit of MONITOR_UNITS) expect(res.stdout).toContain(`ok: ${unit}`);
  });

  it('fails when one monitor unit drifts', () => {
    const { repo, systemd, bin } = makeFixture();
    writeMonitorUnits(repo, systemd);
    writeFileSync(join(systemd, 'bot-errors-tree-provenance.timer'), '[Unit]\nDescription=tampered\n');
    const res = run([
      '--repo-root', repo, '--systemd-dir', systemd, '--bin-dir', bin,
      '--unit', ...MONITOR_UNITS,
      '--no-wrappers',
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('drift: bot-errors-tree-provenance.timer');
    expect(res.stdout).not.toContain('all selected systemd units match');
  });

  it('missing systemd dir is inconclusive (exit 3), not a pass', () => {
    const { repo, bin } = makeFixture();
    const res = run([
      '--repo-root', repo, '--systemd-dir', join(repo, 'nonexistent-systemd'), '--bin-dir', bin,
      '--unit', ...MONITOR_UNITS,
      '--no-wrappers',
    ]);
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('SKIP');
  });
});
