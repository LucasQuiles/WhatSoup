import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const installer = join(repoRoot, 'deploy/scripts/install-host-dependencies.sh');
const roots: string[] = [];

interface Fixture {
  home: string;
  bin: string;
  ledger: string;
  env: NodeJS.ProcessEnv;
}

interface PlanReceipt {
  schemaVersion: number;
  profile: string;
  platform: string;
  manager: string;
  mode: string;
  packages: string[];
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function versionTool(bin: string, name: string, version: string): void {
  executable(join(bin, name), `printf '%s\\n' '${version}'`);
}

function fixture(platform: 'Darwin' | 'Linux' = 'Darwin'): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'whatsoup-host-install-'));
  roots.push(home);
  const bin = join(home, 'bin');
  const ledger = join(home, 'ledger');
  mkdirSync(bin, { recursive: true });
  writeFileSync(ledger, '', 'utf8');

  executable(join(bin, 'uname'), [
    'case "${1:-}" in',
    `  -s) printf '%s\\n' '${platform}' ;;`,
    '  -m) printf "%s\\n" "${FAKE_MACHINE:-arm64}" ;;',
    `  *) printf '%s\\n' '${platform}' ;;`,
    'esac',
  ].join('\n'));
  executable(join(bin, 'sysctl'), 'printf "%s\\n" "${FAKE_ARM64_CAPABLE:-1}"');
  executable(join(bin, 'node'), [
    'case "${1:-}" in',
    "  -v|--version) printf '%s\\n' 'v24.15.0' ;;",
    '  -p) printf "%s\\n" "${FAKE_NODE_ARCH:-arm64}" ;;',
    'esac',
  ].join('\n'));
  versionTool(bin, 'npm', '11.12.1');
  versionTool(bin, 'git', 'git version 2.50.0');
  versionTool(bin, platform === 'Darwin' ? 'launchctl' : 'systemctl', 'service fixture');
  versionTool(bin, platform === 'Darwin' ? 'security' : 'secret-tool', 'credential fixture');
  versionTool(bin, 'rg', 'ripgrep 14.1.1');
  versionTool(bin, 'zsh', 'zsh 5.9');
  versionTool(bin, 'shellcheck', 'ShellCheck 0.11.0');
  versionTool(bin, platform === 'Darwin' ? 'gtimeout' : 'timeout', 'timeout 9.7');
  if (platform === 'Linux') versionTool(bin, 'flock', 'flock 2.40');

  executable(join(bin, 'python3.12'), [
    'case "${1:-}" in',
    "  --version) printf '%s\\n' 'Python 3.12.13' ;;",
    '  -m)',
    '    case "${2:-}" in',
    '      venv)',
    '        printf "python %s\\n" "$*" >> "$WHATSOUP_TEST_LEDGER"',
    '        mkdir -p "$3/bin"',
    '        cp "$0" "$3/bin/python"',
    '        chmod 755 "$3/bin/python"',
    '        ;;',
    '      pip) printf "python %s\\n" "$*" >> "$WHATSOUP_TEST_LEDGER" ;;',
    '    esac',
    '    ;;',
    'esac',
  ].join('\n'));
  executable(join(bin, 'brew'), [
    'printf "brew %s\\n" "$*" >> "$WHATSOUP_TEST_LEDGER"',
  ].join('\n'));
  executable(join(bin, 'apt-get'), 'printf "apt-get %s\\n" "$*" >> "$WHATSOUP_TEST_LEDGER"');
  executable(join(bin, 'pacman'), 'printf "pacman %s\\n" "$*" >> "$WHATSOUP_TEST_LEDGER"');
  executable(join(bin, 'sudo'), [
    'printf "sudo %s\\n" "$*" >> "$WHATSOUP_TEST_LEDGER"',
    '"$@"',
  ].join('\n'));

  return {
    home,
    bin,
    ledger,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      WHATSOUP_TEST_LEDGER: ledger,
      WHATSOUP_QUALITY_VENV: join(home, 'quality-venv'),
    },
  };
}

function runInstaller(
  fx: Fixture,
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('/bin/bash', [installer, ...args], {
    cwd: repoRoot,
    env: fx.env,
    encoding: 'utf8',
    input,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function receipt(result: { stdout: string }): PlanReceipt {
  return JSON.parse(result.stdout) as PlanReceipt;
}

function ledger(fx: Fixture): string[] {
  const content = readFileSync(fx.ledger, 'utf8').trim();
  return content === '' ? [] : content.split('\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('explicit host dependency installer', () => {
  it('plans the complete Homebrew quality profile without mutating', () => {
    const fx = fixture();
    const result = runInstaller(fx, ['--profile', 'quality', '--manager', 'brew', '--json']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(receipt(result)).toMatchObject({
      schemaVersion: 1,
      profile: 'quality',
      platform: 'darwin',
      manager: 'brew',
      mode: 'plan',
      packages: ['git', 'python@3.12', 'ripgrep', 'zsh', 'shellcheck'],
    });
    expect(ledger(fx)).toEqual([]);
  });

  it('plans Linux release packages for apt', () => {
    const fx = fixture('Linux');
    const result = runInstaller(fx, ['--profile', 'release', '--manager', 'apt', '--json']);

    expect(result.status).toBe(0);
    expect(receipt(result).packages).toEqual([
      'git',
      'python3',
      'python3-venv',
      'ripgrep',
      'zsh',
      'shellcheck',
      'coreutils',
      'util-linux',
    ]);
    expect(ledger(fx)).toEqual([]);
  });

  it('plans Linux release packages for pacman', () => {
    const fx = fixture('Linux');
    const result = runInstaller(fx, ['--profile', 'release', '--manager', 'pacman', '--json']);

    expect(result.status).toBe(0);
    expect(receipt(result).packages).toEqual([
      'git',
      'python',
      'python-pip',
      'ripgrep',
      'zsh',
      'shellcheck',
      'coreutils',
      'util-linux',
    ]);
    expect(ledger(fx)).toEqual([]);
  });

  it('refuses non-interactive apply without explicit confirmation', () => {
    const fx = fixture();
    const result = runInstaller(fx, ['--profile', 'quality', '--manager', 'brew', '--apply']);

    expect(result.status).toBe(2);
    expect(ledger(fx)).toEqual([]);
  });

  it('refuses a package manager that disagrees with the host family', () => {
    const fx = fixture();
    const result = runInstaller(fx, [
      '--profile',
      'quality',
      '--manager',
      'apt',
      '--apply',
      '--yes',
    ]);

    expect(result.status).toBe(2);
    expect(ledger(fx)).toEqual([]);
  });

  it('applies one adapter and creates a private managed quality venv', () => {
    const fx = fixture();
    const result = runInstaller(fx, [
      '--profile',
      'quality',
      '--manager',
      'brew',
      '--apply',
      '--yes',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(ledger(fx)).toEqual([
      'brew install git python@3.12 ripgrep zsh shellcheck',
      `python -m venv ${join(fx.home, 'quality-venv')}`,
      'python -m pip install pytest pytest-cov hypothesis ruff==0.15.10',
    ]);
    expect(statSync(join(fx.home, 'quality-venv')).mode & 0o777).toBe(0o700);
  });

  it('fails when the post-install doctor does not pass', () => {
    const fx = fixture();
    unlinkSync(join(fx.bin, 'rg'));
    const result = runInstaller(fx, [
      '--profile',
      'quality',
      '--manager',
      'brew',
      '--apply',
      '--yes',
    ]);

    expect(result.status).toBe(1);
    expect(ledger(fx).length).toBeGreaterThan(0);
  });
});
