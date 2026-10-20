import { chmodSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanPythonDependencyLocks } from '../../scripts/python-dependency-lock-guard.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;
const tempRoots: string[] = [];
const profiles = ['quality', 'transcription'] as const;
const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const;
const lockCases = profiles.flatMap((profile) => targets.map((target) => ({
  profile, target, path: `requirements/python/${profile}-cpython313-${target}.txt`,
})));
const qualityLock = 'requirements/python/quality-cpython313-linux-x64.txt';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-python-lock-'));
  tempRoots.push(root);
  return root;
}

function write(root: string, relativePath: string, contents: string, executable = false): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  if (executable) chmodSync(path, 0o755);
}

function writePolicy(root: string): void {
  write(root, 'requirements/python/lock-policy.json', JSON.stringify({
    schemaVersion: 1,
    runtime: { implementation: 'cpython', version: '3.13.16' },
    indexUrl: 'https://pypi.org/simple',
    locks: Object.fromEntries(profiles.map((profile) => [profile, Object.fromEntries(
      lockCases.filter((entry) => entry.profile === profile).map(({ target, path }) => [target, path]),
    )])),
  }, null, 2));
}

function writeValidLock(root: string): void {
  for (const { target, path } of lockCases) {
    write(root, path, [
      `# Lock target: CPython 3.13.16 / ${target}`,
      'pytest==8.3.5 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '',
    ].join('\n'));
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('python dependency lock guard', () => {
  it('accepts the repository only when every executable pip install uses an approved lock', () => {
    const violations = scanPythonDependencyLocks(repoRoot);

    expect(violations).toEqual([]);
  });

  it('rejects a hash-required install that points at a malformed lock', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'scripts/install.sh', [
      '#!/usr/bin/env bash',
      `python3 -m pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}`,
      '',
    ].join('\n'), true);
    write(root, qualityLock, 'pytest>=8\n');

    const violations = scanPythonDependencyLocks(root);

    expect(violations.some(({ code }) => code === 'python-lock-malformed')).toBe(true);
  });

  it.each(lockCases)('rejects an omitted $profile/$target installer target', ({ profile, target }) => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    const policy = JSON.parse(readFileSync(join(root, 'requirements/python/lock-policy.json'), 'utf8'));
    delete policy.locks[profile][target];
    write(root, 'requirements/python/lock-policy.json', JSON.stringify(policy));

    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-lock-policy-invalid',
    }));
  });

  it.each(lockCases)('rejects a substituted $profile/$target installer lock', ({ profile, target, path }) => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    const policy = JSON.parse(readFileSync(join(root, 'requirements/python/lock-policy.json'), 'utf8'));
    policy.locks[profile][target] = 'requirements/python/replacement.txt';
    write(root, 'requirements/python/replacement.txt', readFileSync(join(root, path), 'utf8'));
    write(root, 'requirements/python/lock-policy.json', JSON.stringify(policy));

    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-lock-policy-invalid',
    }));
  });

  it.each(profiles)('rejects an omitted %s installer profile', (profile) => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    const policy = JSON.parse(readFileSync(join(root, 'requirements/python/lock-policy.json'), 'utf8'));
    delete policy.locks[profile];
    write(root, 'requirements/python/lock-policy.json', JSON.stringify(policy));

    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-lock-policy-invalid',
    }));
  });

  it.each([
    ['direct pip', 'pip install pytest'],
    ['case-insensitive pip', 'PiP3 install pytest'],
    ['continued pip token', 'p\\\nip install pytest'],
    ['python module pip', 'python3 -m pip install pytest'],
    ['multiline shell pip', 'python3 -m pip install \\\n+      pytest'],
    ['workflow pip', 'run: python3 -m pip install pytest'],
    ['equivalent pip3', 'pip3 install pytest'],
    ['module global flag', 'python3 -m pip --isolated install pytest'],
    ['direct global flag', 'pip --disable-pip-version-check install pytest'],
    ['global value', 'python3 -m pip --timeout 10 install pytest'],
    ['quoted global value', 'pip --log "build output.log" install pytest'],
    ['assigned quoted global value', 'pip --log="build output.log" install pytest'],
    ['shell assignment', 'PIP_CONFIG_FILE=/tmp/x pip install pytest'],
    ['multiple shell assignments', 'A=one B="two words" pip3 install pytest'],
    ['indented shell assignment', '  A=one pip install pytest'],
    ['workflow shell assignment', 'run: A=one pip install pytest'],
    ['assignment after a shell separator', 'true && A=one pip install pytest'],
    ['quoted env assignment', 'env A="two words" pip install pytest'],
    ['env cleared environment', 'env -i PATH="$PATH" pip install pytest'],
    ['env long clear option', 'env --ignore-environment pip install pytest'],
    ['env unset value', 'env -u PIP_CONFIG_FILE pip install pytest'],
    ['env attached unset value', 'env -uPIP_CONFIG_FILE pip install pytest'],
    ['env long unset value', 'env --unset=PIP_CONFIG_FILE pip install pytest'],
    ['env working directory', 'env -C "/tmp/build output" pip install pytest'],
    ['env option delimiter', 'env -- pip install pytest'],
    ['env split string', 'env -S "pip install pytest"'],
    ['env unknown option prefix', 'env --unknown-option value pip install pytest'],
    ['escaped assignment', 'PIP_CONFIG_FILE=/tmp/my\\ config pip install pytest'],
    ['command substitution assignment', 'A=$(printf x\\ y) pip install pytest'],
    ['nested command substitution assignment', 'A="$(printf "%s" "$(printf x)")" pip install pytest'],
    ['parameter expansion assignment', 'A=${VALUE:-two words} pip install pytest'],
    ['backtick assignment', 'A=`printf "two words"` pip install pytest'],
    ['command wrapper', 'command pip install pytest'],
    ['command default path', 'command -p pip install pytest'],
    ['repeated command path flag', 'command -pp pip install pytest'],
    ['command option delimiter', 'command -- pip install pytest'],
    ['command path and delimiter', 'command -p -- pip install pytest'],
    ['exec wrapper', 'exec pip install pytest'],
    ['exec option delimiter', 'exec -- pip install pytest'],
    ['exec named process', 'exec -a "worker name" pip install pytest'],
    ['exec attached process name', 'exec -aworker pip install pytest'],
    ['exec flags', 'exec -cl pip install pytest'],
    ['exec combined flags and process name', 'exec -cla worker pip install pytest'],
    ['exec combined flags and attached process name', 'exec -claworker pip install pytest'],
    ['exec reordered flags and quoted process name', 'exec -lca "worker name" pip install pytest'],
    ['exec login flag and process name', 'exec -la worker pip install pytest'],
    ['exec clear-environment flag and process name', 'exec -ca worker pip install pytest'],
    ['exec option-shaped process name', 'exec -ac pip install pytest'],
    ['nohup wrapper', 'nohup pip install pytest'],
    ['timed command', 'time -p pip install pytest'],
    ['nested command wrappers', 'env A=one command exec pip install pytest'],
    ['shell command string', "sh -c 'pip install pytest'"],
    ['shell combined options', 'bash -lc "pip3 install pytest"'],
    ['absolute shell path', "/bin/sh -c 'pip install pytest'"],
    ['nested shell wrapper', 'env A=one command bash -c "pip install pytest"'],
    ['shell command with option value', "bash -o pipefail -c 'pip install pytest'"],
    ['shell command with quoted executable', "'/bin/sh' -c 'pip install pytest'"],
    ['nested shell command', `sh -c "bash -c 'pip install pytest'"`],
    ['shell startup option', "bash --rcfile /tmp/startup -c 'pip install pytest'"],
    ['unresolved shell option', "sh --unknown-option value -c 'pip install pytest'"],
    ['single-quoted shell token concatenation', "sh -c 'pi'p' install pytest'"],
    ['double-quoted shell token concatenation', 'sh -c "pi"p" install pytest"'],
    ['unresolved inner-shell subcommand', "sh -c 'pip ${ACTION} package'"],
    ['quoted shell executable concatenation', `s"h" -c 'pip install pytest'`],
    ['conditional pip command', 'if pip install pytest; then echo ready; fi'],
    ['conditional branch pip command', 'if true; then pip install pytest; fi'],
    ['alternate conditional pip command', 'if false; then true; elif pip install pytest; then true; fi'],
    ['loop condition pip command', 'while pip install pytest; do true; done'],
    ['until condition pip command', 'until pip install pytest; do true; done'],
    ['loop body pip command', 'for item in one; do pip install pytest; done'],
    ['negated pip command', '! pip install pytest'],
    ['unresolved inner command with lock flags', `sh -c 'pip \${ACTION} --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}'`],
    ['concatenated inner pip executable', `sh -c 'pi"p" install pytest'`],
  ])('rejects an unlocked %s invocation', (_name, install) => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'scripts/install.sh', `#!/usr/bin/env bash\n${install}\n`, true);

    const violations = scanPythonDependencyLocks(root);

    expect(violations.some((violation) => (
      violation.code === 'python-install-unlocked' && violation.path === 'scripts/install.sh'
    ))).toBe(true);
  });

  it.each([
    'pip --quiet show install',
    'python3 -m pip --log "build output.log" show install',
    'command -v pip install',
    'command -V pip install',
    'env -u PIP_CONFIG_FILE pip show install',
    'env -- echo pip install',
    "sh -c 'pip show install'",
    "sh -c 'echo pip install'",
  ])('preserves the non-install subcommand in %s', (command) => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'scripts/show.sh', command);
    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it.each([
    'A=<(printf "two words") pip install pytest',
    'A=>(cat >/dev/null) pip install pytest',
    'A=<(cat <(printf "two words")) pip install pytest',
  ])('rejects an unlocked install after process substitution: %s', (command) => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'scripts/install.sh', command);
    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-install-unlocked',
      path: 'scripts/install.sh',
    }));
  });

  it('accepts a locked install after global options', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'scripts/install.sh', `python3 -m pip --isolated --timeout=10 install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}`);
    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it('accepts a literal shell command only when its install uses the approved lock', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'scripts/install.sh', `sh -c 'pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}'`);
    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it.each(['env -i PATH="$PATH"', 'env -u PIP_CONFIG_FILE', 'env --'])(
    'accepts a locked install after %s',
    (prefix) => {
      const root = makeFixture();
      writePolicy(root);
      writeValidLock(root);
      write(root, 'scripts/install.sh', `${prefix} pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}`);
      expect(scanPythonDependencyLocks(root)).toEqual([]);
    },
  );

  it.each([
    'command -p --',
    'exec -a "worker name"',
    'exec -cla worker',
    'exec -claworker',
    'exec -lca "worker name"',
    'exec -la worker',
    'exec -ca worker',
    'exec -ac',
    'nohup',
    'time -p',
  ])(
    'accepts an approved lock through %s',
    (prefix) => {
      const root = makeFixture();
      writePolicy(root);
      writeValidLock(root);
      write(root, 'scripts/install.sh', `${prefix} pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}`);

      expect(scanPythonDependencyLocks(root)).toEqual([]);
    },
  );

  it.each(['scripts/large.sh', 'requirements/python/lock-policy.json', qualityLock])(
    'fails closed before reading an oversized %s',
    (path) => {
      const root = makeFixture();
      writePolicy(root);
      writeValidLock(root);
      write(root, path, '');
      truncateSync(join(root, path), 4 * 1024 * 1024 + 1);

      expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
        code: 'python-lock-scan-limit',
        path,
      }));
    },
  );

  it('fails closed when individually bounded files exceed the total byte budget', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    for (let index = 0; index < 17; index += 1) {
      const path = `scripts/part-${index}.sh`;
      write(root, path, '');
      truncateSync(join(root, path), 4 * 1024 * 1024);
    }

    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-lock-scan-limit',
      detail: expect.stringContaining('total bytes'),
    }));
  });

  it('fails closed on excessive directory entries', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    mkdirSync(join(root, 'scripts'));
    for (let index = 0; index < 10_001; index += 1) {
      writeFileSync(join(root, 'scripts', `part-${index}.sh`), '');
    }

    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-lock-scan-limit',
      detail: expect.stringContaining('entries'),
    }));
  });

  it('fails closed on excessive directory nesting', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, `${'nested/'.repeat(65)}install.sh`, '# bounded traversal');

    expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
      code: 'python-lock-scan-limit',
      detail: expect.stringContaining('depth'),
    }));
  });

  it('accepts files at the per-file and shared total-byte boundaries', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    const metadataBytes = 2 * (
      readFileSync(join(root, 'requirements/python/lock-policy.json')).length
      + lockCases.reduce((bytes, { path }) => bytes + readFileSync(join(root, path)).length, 0)
    );
    for (let index = 0; index < 16; index += 1) {
      const path = `scripts/part-${index}.sh`;
      write(root, path, '');
      truncateSync(join(root, path), 4 * 1024 * 1024 - (index === 15 ? metadataBytes : 0));
    }

    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it('accepts exactly 10000 directory entries', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    mkdirSync(join(root, 'scripts'));
    // The policy, eight locks and their directories account for the other twelve entries.
    for (let index = 0; index < 9988; index += 1) {
      writeFileSync(join(root, 'scripts', `part-${index}.sh`), '');
    }

    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it('accepts exactly 64 nested directories', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, `${'nested/'.repeat(64)}install.sh`, '# bounded traversal');

    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it('does not treat documentation or test fixtures as executable production installers', () => {
    const root = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(root, 'docs/example.md', 'python3 -m pip install pytest\n');
    write(root, 'tests/fixtures/install.sh', 'python3 -m pip install pytest\n', true);
    write(root, 'scripts/install.sh', [
      '#!/usr/bin/env bash',
      `python3 -m pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r ${qualityLock}`,
      '',
    ].join('\n'), true);

    const violations = scanPythonDependencyLocks(root);

    expect(violations).toEqual([]);
  });

  it.each(['excluded-file', 'external-file', 'external-directory', 'dangling'] as const)(
    'rejects an installer symlink to %s instead of silently skipping it',
    (targetKind) => {
      const root = makeFixture();
      const external = makeFixture();
      writePolicy(root);
      writeValidLock(root);
      write(root, 'docs/unlocked.sh', 'pip install pytest\n');
      write(external, 'unlocked.sh', 'pip install pytest\n');
      mkdirSync(join(root, 'scripts'));
      const targets = {
        'excluded-file': '../docs/unlocked.sh',
        'external-file': join(external, 'unlocked.sh'),
        'external-directory': external,
        dangling: join(external, 'missing.sh'),
      };
      symlinkSync(targets[targetKind], join(root, 'scripts/install.sh'));

      expect(scanPythonDependencyLocks(root)).toContainEqual(expect.objectContaining({
        code: 'python-lock-scan-input',
        path: 'scripts/install.sh',
      }));
    },
  );

  it('retains the explicit dependency-directory exclusion for a dependency symlink', () => {
    const root = makeFixture();
    const external = makeFixture();
    writePolicy(root);
    writeValidLock(root);
    write(external, 'install.sh', 'pip install pytest\n');
    symlinkSync(external, join(root, 'node_modules'), 'dir');

    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });
});
