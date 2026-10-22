import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const doctor = join(repoRoot, 'deploy/scripts/whatsoup-host-doctor.sh');
const roots: string[] = [];

interface CapabilityRecord {
  id: string;
  status: string;
  versionRule: string;
}

interface DoctorReceipt {
  schemaVersion: number;
  profile: string;
  nodePolicy: string;
  platform: string;
  outcome: string;
  records: CapabilityRecord[];
}

interface Fixture {
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function tool(bin: string, name: string, version: string): void {
  executable(join(bin, name), `printf '%s\\n' '${version}'`);
}

function resolveHostTool(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the host PATH.
    }
  }
  throw new Error(`host test prerequisite missing: ${name}`);
}

function installShellToolbox(bin: string): void {
  for (const name of ['bash', 'cat', 'dirname', 'sed', 'tr']) {
    symlinkSync(resolveHostTool(name), join(bin, name));
  }
}

function fixture(overrides: NodeJS.ProcessEnv = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'whatsoup-host-doctor-'));
  roots.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  installShellToolbox(bin);

  executable(join(bin, 'uname'), [
    'case "${1:-}" in',
    '  -s) printf "%s\\n" "${FAKE_PLATFORM:-Darwin}"; exit "${FAKE_PLATFORM_EXIT:-0}" ;;',
    '  -m) printf "%s\\n" "${FAKE_MACHINE:-arm64}" ;;',
    '  *) printf "%s\\n" "${FAKE_PLATFORM:-Darwin}" ;;',
    'esac',
  ].join('\n'));
  executable(join(bin, 'sysctl'), [
    'case "$*" in',
    '  *hw.optional.arm64*) printf "%s\\n" "${FAKE_ARM64_CAPABLE:-1}"; exit "${FAKE_ARM64_EXIT:-0}" ;;',
    '  *sysctl.proc_translated*) printf "%s\\n" "${FAKE_TRANSLATED:-0}" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));
  executable(join(bin, 'node'), [
    'case "${1:-}" in',
    '  -v|--version) printf "v%s\\n" "${FAKE_NODE_VERSION:-24.15.0}"; exit "${FAKE_NODE_VERSION_EXIT:-0}" ;;',
    '  -p) printf "%s\\n" "${FAKE_NODE_ARCH:-arm64}"; exit "${FAKE_NODE_ARCH_EXIT:-0}" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
  tool(bin, 'npm', '11.12.1');
  tool(bin, 'git', 'git version 2.50.0');
  tool(bin, 'launchctl', 'launchctl fixture');
  executable(join(bin, 'security'), "printf '%s\\n' 'SECRET_SHOULD_NOT_APPEAR'");
  tool(bin, 'python3.12', 'Python 3.12.11');
  tool(bin, 'rg', 'ripgrep 14.1.1');
  tool(bin, 'zsh', 'zsh 5.9');
  tool(bin, 'shellcheck', 'ShellCheck 0.10.0');
  tool(bin, 'gtimeout', 'timeout (GNU coreutils) 9.7');

  return {
    home,
    bin,
    env: {
      ...process.env,
      HOME: home,
      USER: 'fixture-user',
      PATH: bin,
      ...overrides,
    },
  };
}

function runDoctor(
  fx: Fixture,
  args: string[],
): { status: number | null; stdout: string; stderr: string; receipt: DoctorReceipt | null } {
  const result = spawnSync('/bin/bash', [doctor, ...args], {
    cwd: repoRoot,
    env: fx.env,
    encoding: 'utf8',
  });
  let receipt: DoctorReceipt | null = null;
  try {
    receipt = JSON.parse(result.stdout) as DoctorReceipt;
  } catch {
    receipt = null;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    receipt,
  };
}

function record(receipt: DoctorReceipt | null, id: string): CapabilityRecord | undefined {
  return receipt?.records.find((candidate) => candidate.id === id);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portable host capability doctor', () => {
  it.each([
    ['npm', 'npm', '11.12.1'],
    ['git', 'git', 'git version 2.50.0'],
    ['python', 'python3.12', 'Python 3.12.11'],
    ['rg', 'rg', 'ripgrep 14.1.1'],
    ['zsh', 'zsh', 'zsh 5.9'],
    ['shellcheck', 'shellcheck', 'ShellCheck 0.10.0'],
    ['timeout', 'gtimeout', 'timeout (GNU coreutils) 9.7'],
  ])('does not accept %s version output from a failed child', (id, name, version) => {
    const fx = fixture();
    executable(join(fx.bin, name), `printf '%s\\n' '${version}'\nexit 17`);

    const result = runDoctor(fx, ['--profile', 'release', '--json']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.receipt?.outcome).toBe('inconclusive');
    expect(record(result.receipt, id)?.status).toBe('inconclusive');
  });

  it.each(['FAKE_NODE_VERSION_EXIT', 'FAKE_NODE_ARCH_EXIT', 'FAKE_ARM64_EXIT'])(
    'does not accept plausible Node evidence when %s is nonzero',
    (variable) => {
      const result = runDoctor(fixture({ [variable]: '19' }), ['--profile', 'runtime', '--json']);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.receipt?.outcome).toBe('inconclusive');
      expect(record(result.receipt, 'node')?.status).toBe('inconclusive');
    },
  );

  it.each(['', '   '])('does not treat empty probe output %j as available', (output) => {
    const fx = fixture();
    tool(fx.bin, 'npm', output);

    const result = runDoctor(fx, ['--profile', 'runtime', '--json']);

    expect(result.status).toBe(2);
    expect(result.receipt?.outcome).toBe('inconclusive');
    expect(record(result.receipt, 'npm')?.status).toBe('inconclusive');
  });

  it('does not treat signal-terminated probe output as available', () => {
    const fx = fixture();
    executable(join(fx.bin, 'npm'), "printf '%s\\n' '11.12.1'\nkill -TERM \"$$\"");

    const result = runDoctor(fx, ['--profile', 'runtime', '--json']);

    expect(result.status).toBe(2);
    expect(result.receipt?.outcome).toBe('inconclusive');
    expect(record(result.receipt, 'npm')?.status).toBe('inconclusive');
  });

  it('does not accept a failed capability output formatter', () => {
    const fx = fixture();
    fx.env.WHATSOUP_TEST_REAL_SED = resolveHostTool('sed');
    unlinkSync(join(fx.bin, 'sed'));
    executable(join(fx.bin, 'sed'), [
      'probe_output="$(cat)"',
      'if [ "$probe_output" = "11.12.1" ]; then',
      '  printf "%s\\n" "$probe_output"',
      '  exit 23',
      'fi',
      'exec "$WHATSOUP_TEST_REAL_SED" "$@" <<< "$probe_output"',
    ].join('\n'));

    const result = runDoctor(fx, ['--profile', 'runtime', '--json']);

    expect(result.status).toBe(2);
    expect(result.receipt?.outcome).toBe('inconclusive');
    expect(record(result.receipt, 'npm')?.status).toBe('inconclusive');
  });

  it('rejects a failed platform output formatter before emitting capability records', () => {
    const fx = fixture();
    unlinkSync(join(fx.bin, 'sed'));
    executable(join(fx.bin, 'sed'), "printf '%s\\n' 'Darwin'\nexit 23");

    const result = runDoctor(fx, ['--profile', 'runtime', '--json']);

    expect(result.status).toBe(2);
    expect(result.receipt).toBeNull();
    expect(result.stderr).toContain('unsupported or unreadable platform');
  });

  it.each([
    { options: [] },
    { options: ['-e'] },
    { options: ['-o', 'pipefail'] },
    { options: ['-e', '-o', 'pipefail'] },
  ])(
    'preserves the originating child exit with caller options $options',
    ({ options }) => {
      const result = spawnSync('/bin/bash', [
        ...options,
        '-c',
        '. "$1"; whatsoup_first_line /bin/bash -c \'printf "plausible\\n"; exit 17\'',
        'probe',
        join(repoRoot, 'deploy/lib/host-capabilities.sh'),
      ], { encoding: 'utf8' });

      expect(result.status, result.stderr).toBe(17);
    },
  );

  it('rejects plausible platform output from a failed discovery command', () => {
    const result = runDoctor(fixture({ FAKE_PLATFORM_EXIT: '17' }), ['--profile', 'runtime', '--json']);

    expect(result.status).toBe(2);
    expect(result.receipt).toBeNull();
    expect(result.stderr).toContain('unsupported or unreadable platform');
  });

  it('passes a complete Darwin runtime profile with exact native Node', () => {
    const result = runDoctor(fixture(), ['--profile', 'runtime', '--json']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      profile: 'runtime',
      nodePolicy: 'exact',
      platform: 'darwin',
      outcome: 'pass',
    });
    expect(record(result.receipt, 'node')).toMatchObject({
      status: 'available',
      versionRule: 'exact:24.15.0',
    });
  });

  it('rejects a version-correct-major Node that misses the exact patch pin', () => {
    const result = runDoctor(
      fixture({ FAKE_NODE_VERSION: '24.15.1' }),
      ['--profile', 'runtime', '--json'],
    );

    expect(result.status).toBe(1);
    expect(record(result.receipt, 'node')?.status).toBe('incompatible');
  });

  it('rejects an x64 Node process on an arm64-native host', () => {
    const result = runDoctor(
      fixture({ FAKE_NODE_ARCH: 'x64' }),
      ['--profile', 'runtime', '--json'],
    );

    expect(result.status).toBe(1);
    expect(record(result.receipt, 'node')?.status).toBe('incompatible');
  });

  it('is inconclusive when native host architecture cannot be normalized', () => {
    const result = runDoctor(
      fixture({ FAKE_ARM64_CAPABLE: '0', FAKE_MACHINE: 'mips64' }),
      ['--profile', 'runtime', '--json'],
    );

    expect(result.status).toBe(2);
    expect(record(result.receipt, 'node')?.status).toBe('inconclusive');
    expect(result.receipt?.outcome).toBe('inconclusive');
  });

  it('is inconclusive when the Darwin arm64 capability probe is unexpected', () => {
    const result = runDoctor(
      fixture({
        FAKE_ARM64_CAPABLE: 'unexpected',
        FAKE_MACHINE: 'x86_64',
        FAKE_NODE_ARCH: 'x64',
      }),
      ['--profile', 'runtime', '--json'],
    );

    expect(result.status).toBe(2);
    expect(record(result.receipt, 'node')?.status).toBe('inconclusive');
    expect(result.receipt?.outcome).toBe('inconclusive');
  });

  it('reports a service-root-only executable as PATH-hidden', () => {
    const fx = fixture();
    unlinkSync(join(fx.bin, 'rg'));
    const serviceBin = join(fx.home, '.local/bin');
    mkdirSync(serviceBin, { recursive: true });
    tool(serviceBin, 'rg', 'ripgrep 14.1.1');

    const result = runDoctor(fx, ['--profile', 'quality', '--json']);

    expect(result.status).toBe(1);
    expect(record(result.receipt, 'rg')?.status).toBe('path_hidden');
  });

  it('marks external flock platform-inapplicable for Darwin release checks', () => {
    const result = runDoctor(fixture(), ['--profile', 'release', '--json']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(record(result.receipt, 'flock')?.status).toBe('not_applicable');
  });

  it('never executes a credential command or prints credential material', () => {
    const result = runDoctor(fixture(), ['--profile', 'runtime', '--json']);

    expect(`${result.stdout}\n${result.stderr}`).not.toContain('SECRET_SHOULD_NOT_APPEAR');
    expect(record(result.receipt, 'credential_store')?.status).toBe('available');
  });

  it('labels an engine-compatible Node receipt as compatibility-only', () => {
    const result = runDoctor(
      fixture({ FAKE_NODE_VERSION: '25.3.0', FAKE_NODE_ARCH: 'arm64' }),
      ['--profile', 'quality', '--node-policy', 'compatibility', '--json'],
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.receipt?.outcome).toBe('compatibility_only');
    expect(result.receipt?.nodePolicy).toBe('compatibility');
  });

  it('rejects malformed arguments as inconclusive infrastructure', () => {
    const result = runDoctor(fixture(), ['--profile', 'runtime', '--unknown']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});
