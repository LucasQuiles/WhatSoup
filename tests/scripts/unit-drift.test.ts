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
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
  });
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
});
