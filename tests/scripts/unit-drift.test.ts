import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/check-unit-drift.sh');
const tmpDirs: string[] = [];

function makeFixture(): { repo: string; systemd: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-unit-drift-'));
  tmpDirs.push(root);
  const repo = join(root, 'repo');
  const systemd = join(root, 'systemd');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(systemd, { recursive: true });
  chmodSync(SCRIPT, 0o755);
  return { repo, systemd };
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
    const { repo, systemd } = makeFixture();
    const content = '[Unit]\nDescription=Match\n';
    writeFileSync(join(repo, 'deploy/example.service'), content);
    writeFileSync(join(systemd, 'example.service'), content);

    const result = run(['--repo-root', repo, '--systemd-dir', systemd, '--unit', 'example.service']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: example.service');
    expect(result.stdout).toContain('all managed systemd units match');
  });

  it('fails and prints a diff when an installed unit has drifted', () => {
    const { repo, systemd } = makeFixture();
    writeFileSync(join(repo, 'deploy/example.service'), '[Unit]\nDescription=Repo\n');
    writeFileSync(join(systemd, 'example.service'), '[Unit]\nDescription=Live\n');

    const result = run(['--repo-root', repo, '--systemd-dir', systemd, '--unit', 'example.service']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drift: example.service');
    expect(result.stderr).toContain('-Description=Repo');
    expect(result.stderr).toContain('+Description=Live');
  });

  it('fails when a managed unit is not installed', () => {
    const { repo, systemd } = makeFixture();
    writeFileSync(join(repo, 'deploy/example.service'), '[Unit]\nDescription=Repo\n');

    const result = run(['--repo-root', repo, '--systemd-dir', systemd, '--unit', 'example.service']);

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
});
