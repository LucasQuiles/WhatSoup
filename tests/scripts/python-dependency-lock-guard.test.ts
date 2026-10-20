import { chmodSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanPythonDependencyLocks } from '../../scripts/python-dependency-lock-guard.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;
const tempRoots: string[] = [];

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

function writePolicy(root: string, lockPath = 'locks/quality-cpython313.txt'): void {
  write(root, 'requirements/python/lock-policy.json', JSON.stringify({
    schemaVersion: 1,
    runtime: { implementation: 'cpython', version: '3.13.16' },
    indexUrl: 'https://pypi.org/simple',
    locks: { quality: { 'linux-x64': lockPath } },
  }, null, 2));
}

function writeValidLock(root: string, lockPath = 'locks/quality-cpython313.txt'): void {
  write(root, lockPath, [
    '# Lock target: CPython 3.13.16 / linux-x64',
    'pytest==8.3.5 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '',
  ].join('\n'));
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
    writePolicy(root, 'locks/quality-py313.txt');
    write(root, 'scripts/install.sh', [
      '#!/usr/bin/env bash',
      'python3 -m pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r locks/quality-py313.txt',
      '',
    ].join('\n'), true);
    write(root, 'locks/quality-py313.txt', 'pytest>=8\n');

    const violations = scanPythonDependencyLocks(root);

    expect(violations.some(({ code }) => code === 'python-lock-malformed')).toBe(true);
  });

  it.each([
    ['direct pip', 'pip install pytest'],
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
    ['escaped assignment', 'PIP_CONFIG_FILE=/tmp/my\\ config pip install pytest'],
    ['command substitution assignment', 'A=$(printf x\\ y) pip install pytest'],
    ['nested command substitution assignment', 'A="$(printf "%s" "$(printf x)")" pip install pytest'],
    ['parameter expansion assignment', 'A=${VALUE:-two words} pip install pytest'],
    ['backtick assignment', 'A=`printf "two words"` pip install pytest'],
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

  it.each(['pip --quiet show install', 'python3 -m pip --log "build output.log" show install'])('preserves the non-install subcommand in %s', (command) => {
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
    write(root, 'scripts/install.sh', 'python3 -m pip --isolated --timeout=10 install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r locks/quality-cpython313.txt');
    expect(scanPythonDependencyLocks(root)).toEqual([]);
  });

  it.each(['scripts/large.sh', 'requirements/python/lock-policy.json', 'locks/quality-cpython313.txt'])(
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
      + readFileSync(join(root, 'locks/quality-cpython313.txt')).length
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
    // The policy/lock paths and scripts directory account for the other six entries.
    for (let index = 0; index < 9994; index += 1) {
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
      'python3 -m pip install --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r locks/quality-cpython313.txt',
      '',
    ].join('\n'), true);

    const violations = scanPythonDependencyLocks(root);

    expect(violations).toEqual([]);
  });
});
