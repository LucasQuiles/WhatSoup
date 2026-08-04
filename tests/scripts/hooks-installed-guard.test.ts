import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUIRED_HOOK_PATHS,
  HOOK_ENTRYPOINTS,
  HOOK_HELPERS,
  MAX_HOOK_RECEIPT_BYTES,
  interpretSymbolicHeadAttempt,
  parseHookIdentityReceiptBytes,
  readBoundDirectoryNames,
  inspectHookInstallation,
  enforceStableHookLineage,
  enforceHookReceiptCloseFailure,
  hookReadCodeAfterCloseFailure,
  hookIdentityEvidenceDigest,
  runHooksInstalledGuard,
  serializeHookIdentityReceipt,
  validateHookIdentityReceipt,
  withStableHeadLineage,
} from '../../scripts/hooks-installed-guard.ts';
import { reasonDefinition } from '../../scripts/lib/ci-control/reasons.ts';
import { loadControlManifest } from '../../scripts/lib/ci-control/manifest.ts';
import { cleanGitEnv } from '../../src/lib/git-env.ts';

const roots: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...cleanGitEnv(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

function writeExecutable(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function repoFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-hook-identity-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Hook Fixture']);
  git(root, ['config', 'user.email', 'hook-fixture@example.invalid']);
  for (const relativePath of REQUIRED_HOOK_PATHS) {
    writeExecutable(resolve(root, relativePath), `#!/bin/sh\n# ${relativePath}\nexit 0\n`);
  }
  git(root, ['add', '--', '.husky']);
  git(root, ['commit', '-m', 'fixture hooks']);
  git(root, ['config', 'core.hooksPath', '.husky']);
  return root;
}

// spawnSync fixture repos, ACL ops, and the pinned-npm guard run can exceed
// the 10s default (observed as pure timeouts with every assertion green);
// 30s keeps the local workflow fast while accommodating the subprocess overhead.
describe('repository hook installation identity', { timeout: 30_000 }, () => {
  it('passes only for canonical relative hooks whose complete closure matches HEAD', () => {
    const root = repoFixture();

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.code).toBe('ci.hooks.pass');
    expect(result.hooks.map((hook) => hook.path)).toEqual([...REQUIRED_HOOK_PATHS]);
    expect(result.hooks.every((hook) => hook.expectedMode === '100755')).toBe(true);
    expect(result.hooks.every((hook) => hook.observedMode === '100755')).toBe(true);
  });

  it('is inconclusive for an identical absolute hook directory owned by another linked worktree', () => {
    const root = repoFixture();
    const linked = resolve(dirname(root), `${root.split('/').pop()}-linked`);
    roots.push(linked);
    git(root, ['worktree', 'add', '-b', 'linked', linked]);
    git(linked, ['config', 'core.hooksPath', resolve(root, '.husky')]);

    const result = inspectHookInstallation(linked);
    const serialized = JSON.stringify(result);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.path-foreign');
    expect(result.observedHeadOid).toBeNull();
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(linked);
  });

  it('rejects even a current-worktree absolute path as nonportable', () => {
    const root = repoFixture();
    git(root, ['config', 'core.hooksPath', resolve(root, '.husky')]);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.path-absolute');
  });

  it('does not trust a PATH-prepended git executable to forge hook identity', () => {
    const root = repoFixture();
    const foreign = resolve(root, 'foreign-hooks');
    const bin = resolve(root, 'bin');
    const marker = resolve(root, 'fake-git-ran');
    mkdirSync(foreign, { recursive: true });
    mkdirSync(bin, { recursive: true });
    git(root, ['config', 'core.hooksPath', foreign]);
    writeExecutable(resolve(bin, 'git'), [
      '#!/bin/sh',
      `printf ran > ${JSON.stringify(marker)}`,
      'if [ "$1" = config ] && [ "$2" = --get ] && [ "$3" = core.hooksPath ]; then',
      '  printf "%s\\n" .husky',
      '  exit 0',
      'fi',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'));
    const beforePath = process.env.PATH;
    process.env.PATH = `${bin}:${beforePath ?? ''}`;
    try {
      const result = inspectHookInstallation(root);
      expect(result.outcome).toBe('inconclusive');
      expect(result.exitCode).toBe(2);
      expect(result.code).toBe('ci.hooks.path-foreign');
      expect(result.gitExecutable).toMatchObject({
        identity: 'system',
        launcherDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        implementationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(() => lstatSync(marker)).toThrow();
    } finally {
      if (beforePath === undefined) delete process.env.PATH;
      else process.env.PATH = beforePath;
    }
  });

  it('rejects escaping, missing, and disabled hook paths without echoing them', () => {
    const root = repoFixture();
    for (const [configured, code] of [
      ['../foreign-hooks', 'ci.hooks.path-escaping'],
      ['missing-hooks', 'ci.hooks.path-missing'],
      ['/dev/null', 'ci.hooks.path-disabled'],
    ] as const) {
      git(root, ['config', 'core.hooksPath', configured]);
      const result = inspectHookInstallation(root);
      expect(result.outcome).toBe('inconclusive');
      expect(result.exitCode).toBe(2);
      expect(result.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain(configured);
    }
  });

  it('rejects a symlinked hook even when its target has the committed bytes', () => {
    const root = repoFixture();
    const target = resolve(root, 'pre-push-copy');
    copyFileSync(resolve(root, '.husky/pre-push'), target);
    chmodSync(target, 0o755);
    unlinkSync(resolve(root, '.husky/pre-push'));
    symlinkSync(target, resolve(root, '.husky/pre-push'));

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-symlink');
  });

  it('rejects a symlinked hook root even when the target has the committed closure', () => {
    const root = repoFixture();
    const target = resolve(root, 'hook-root-copy');
    mkdirSync(target);
    for (const relativePath of REQUIRED_HOOK_PATHS) {
      copyFileSync(resolve(root, relativePath), resolve(target, relativePath.split('/').pop()!));
      chmodSync(resolve(target, relativePath.split('/').pop()!), 0o755);
    }
    rmSync(resolve(root, '.husky'), { recursive: true });
    symlinkSync(target, resolve(root, '.husky'));

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-symlink');
  });

  it('binds installed closure enumeration to the directory identity selected before a root swap', () => {
    const root = repoFixture();
    const expectedRoot = resolve(root, '.husky');
    const original = resolve(root, '.husky-original');
    const alternate = resolve(root, '.husky-alternate');
    mkdirSync(alternate);
    writeExecutable(resolve(alternate, 'unexpected'), '#!/bin/sh\nexit 0\n');
    const descriptor = openSync(expectedRoot, 'r');
    const expectedIdentity = fstatSync(descriptor, { bigint: true });
    closeSync(descriptor);
    renameSync(expectedRoot, original);
    renameSync(alternate, expectedRoot);
    try {
      const result = readBoundDirectoryNames(expectedRoot, expectedIdentity);
      expect(result).toEqual({ ok: false, code: 'ci.hooks.installed-identity-changed' });
    } finally {
      renameSync(expectedRoot, alternate);
      renameSync(original, expectedRoot);
    }
  });

  it('rejects an unexpected executable hook outside the declared closure', () => {
    const root = repoFixture();
    writeExecutable(resolve(root, '.husky/post-checkout'), '#!/bin/sh\nexit 0\n');

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-unexpected');
  });

  it('blocks an undeclared committed hook even when it is absent from the installed directory', () => {
    const root = repoFixture();
    const extra = resolve(root, '.husky/post-checkout');
    writeExecutable(extra, '#!/bin/sh\nexit 0\n');
    git(root, ['add', '--', '.husky/post-checkout']);
    git(root, ['commit', '-m', 'add undeclared committed hook']);
    unlinkSync(extra);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('block');
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe('ci.hooks.source-invalid');
  });

  it.each([
    ['non-executable file', (root: string) => writeFileSync(resolve(root, '.husky/notes.txt'), 'notes\n')],
    ['directory', (root: string) => mkdirSync(resolve(root, '.husky/nested'))],
  ])('rejects an unexpected %s outside the declared closure', (_name, mutate) => {
    const root = repoFixture();
    mutate(root);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-unexpected');
  });

  it('rejects a hook that has an execute bit but is not executable by the current user', () => {
    const root = repoFixture();
    chmodSync(resolve(root, '.husky/pre-push'), 0o401);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-mode-mismatch');
  });

  it('rejects a hook denied effective execution by the observed host authorization model', () => {
    const root = repoFixture();
    const hook = resolve(root, '.husky/pre-push');
    if (process.platform === 'darwin') {
      const identity = spawnSync('/usr/bin/id', ['-un'], { encoding: 'utf8' });
      expect(identity.status, identity.stderr).toBe(0);
      const denied = spawnSync('/bin/chmod', ['+a', `user:${identity.stdout.trim()} deny execute`, hook], { encoding: 'utf8' });
      expect(denied.status, denied.stderr).toBe(0);
    } else {
      chmodSync(hook, 0o401);
    }

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-mode-mismatch');
  });

  it('rejects group-or-world-writable hook and root installations', () => {
    for (const relativePath of ['.husky/pre-push', '.husky'] as const) {
      const root = repoFixture();
      chmodSync(resolve(root, relativePath), 0o777);

      const result = inspectHookInstallation(root);

      expect(result.outcome).toBe('inconclusive');
      expect(result.exitCode).toBe(2);
      expect(result.code).toBe('ci.hooks.installed-mode-mismatch');
    }
  });

  it('rejects an external hardlink even when its bytes and mode match', () => {
    const root = repoFixture();
    const external = resolve(root, 'external-pre-push');
    copyFileSync(resolve(root, '.husky/pre-push'), external);
    chmodSync(external, 0o755);
    unlinkSync(resolve(root, '.husky/pre-push'));
    linkSync(external, resolve(root, '.husky/pre-push'));

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.installed-hardlink');
  });

  it('rejects installed byte, helper, executable-mode, and missing-file drift', () => {
    const cases = [
      {
        mutate(root: string) {
          writeExecutable(resolve(root, '.husky/pre-push'), '#!/bin/sh\nexit 9\n');
        },
        code: 'ci.hooks.installed-bytes-mismatch',
      },
      {
        mutate(root: string) {
          writeExecutable(resolve(root, '.husky/check-commit-identity.sh'), '#!/bin/sh\nexit 9\n');
        },
        code: 'ci.hooks.installed-bytes-mismatch',
      },
      {
        mutate(root: string) {
          chmodSync(resolve(root, '.husky/pre-commit'), 0o644);
        },
        code: 'ci.hooks.installed-mode-mismatch',
      },
      {
        mutate(root: string) {
          unlinkSync(resolve(root, '.husky/commit-msg'));
        },
        code: 'ci.hooks.installed-missing',
      },
    ];

    for (const testCase of cases) {
      const root = repoFixture();
      testCase.mutate(root);
      const result = inspectHookInstallation(root);
      expect(result.outcome).toBe('inconclusive');
      expect(result.exitCode).toBe(2);
      expect(result.code).toBe(testCase.code);
      expect(reasonDefinition(result.code)?.defaultOutcome).toBe('inconclusive');
    }
  });

  it('blocks a deterministically incomplete committed hook contract', () => {
    const root = repoFixture();
    unlinkSync(resolve(root, '.husky/check-commit-identity.sh'));
    git(root, ['add', '-u', '--', '.husky/check-commit-identity.sh']);
    git(root, ['commit', '-m', 'remove required helper']);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('block');
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe('ci.hooks.source-missing');
    expect(reasonDefinition(result.code)?.defaultOutcome).toBe('block');
  });

  it('blocks a committed required hook whose Git mode is not executable', () => {
    const root = repoFixture();
    chmodSync(resolve(root, '.husky/pre-commit'), 0o644);
    git(root, ['add', '--', '.husky/pre-commit']);
    git(root, ['commit', '-m', 'remove executable mode']);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('block');
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe('ci.hooks.source-invalid');
  });

  it('blocks a committed required hook whose Git type is not a blob', () => {
    const root = repoFixture();
    const target = resolve(root, 'committed-hook-target');
    writeExecutable(target, '#!/bin/sh\nexit 0\n');
    unlinkSync(resolve(root, '.husky/pre-commit'));
    symlinkSync('../committed-hook-target', resolve(root, '.husky/pre-commit'));
    git(root, ['add', '--', '.husky/pre-commit']);
    git(root, ['commit', '-m', 'replace hook with symlink']);

    const result = inspectHookInstallation(root);

    expect(result.outcome).toBe('block');
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe('ci.hooks.source-invalid');
  });

  it('detects HEAD A-to-B-to-A movement through the production lineage envelope', () => {
    const root = repoFixture();
    const a = git(root, ['rev-parse', 'HEAD']);
    git(root, ['commit', '--allow-empty', '-m', 'lineage B']);
    const b = git(root, ['rev-parse', 'HEAD']);
    git(root, ['update-ref', 'refs/heads/main', a, b]);

    const evaluation = withStableHeadLineage(root, () => {
      git(root, ['update-ref', 'refs/heads/main', b, a]);
      git(root, ['update-ref', 'refs/heads/main', a, b]);
      return { provisionalOutcome: 'block' as const };
    });

    expect(evaluation.value).toEqual({ provisionalOutcome: 'block' });
    expect(evaluation.initialOid).toBe(a);
    expect(evaluation.finalOid).toBe(a);
    expect(evaluation.stable).toBe(false);
  });

  it('treats only the documented symbolic-ref status as detached lineage', () => {
    expect(interpretSymbolicHeadAttempt({
      status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: undefined,
    })).toEqual({
      ok: true,
      symbolicRef: null,
    });
    expect(interpretSymbolicHeadAttempt({
      status: 2, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: undefined,
    })).toEqual({
      ok: false,
    });
    expect(interpretSymbolicHeadAttempt({
      status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: undefined,
    })).toEqual({
      ok: false,
    });
  });

  it('converts unstable provisional block evidence to inconclusive lineage evidence', () => {
    const root = repoFixture();
    unlinkSync(resolve(root, '.husky/pre-commit'));
    git(root, ['add', '-u', '--', '.husky/pre-commit']);
    git(root, ['commit', '-m', 'remove required hook']);
    const provisional = inspectHookInstallation(root);
    expect(provisional.outcome).toBe('block');

    const result = enforceStableHookLineage({
      value: provisional,
      stable: false,
      code: 'ci.hooks.head-moved',
      initialOid: provisional.expectedOid,
      finalOid: provisional.expectedOid,
    });

    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe('ci.hooks.head-moved');
  });

  it('preserves primary failures across cleanup and downgrades provisional success', () => {
    expect(hookReadCodeAfterCloseFailure('ci.hooks.installed-identity-changed')).toBe(
      'ci.hooks.installed-identity-changed',
    );
    expect(hookReadCodeAfterCloseFailure(null)).toBe('ci.hooks.evidence-unavailable');

    const root = repoFixture();
    const pass = inspectHookInstallation(root);
    expect(enforceHookReceiptCloseFailure(pass)).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.hooks.evidence-unavailable',
    });

    unlinkSync(resolve(root, '.husky/pre-commit'));
    git(root, ['add', '-u', '--', '.husky/pre-commit']);
    git(root, ['commit', '-m', 'remove required hook after pass']);
    const block = inspectHookInstallation(root);
    expect(block.outcome).toBe('block');
    expect(enforceHookReceiptCloseFailure(block)).toBe(block);
  });

  it('does not mutate configuration or installed files while inspecting', () => {
    const root = repoFixture();
    const beforeConfig = readFileSync(resolve(root, '.git/config'));
    const before = Object.fromEntries(REQUIRED_HOOK_PATHS.map((path) => [
      path,
      {
        bytes: readFileSync(resolve(root, path)),
        mode: lstatSync(resolve(root, path)).mode,
      },
    ]));

    inspectHookInstallation(root);

    expect(readFileSync(resolve(root, '.git/config'))).toEqual(beforeConfig);
    for (const relativePath of REQUIRED_HOOK_PATHS) {
      expect(readFileSync(resolve(root, relativePath))).toEqual(before[relativePath]!.bytes);
      expect(lstatSync(resolve(root, relativePath)).mode).toBe(before[relativePath]!.mode);
    }
  });

  it('exposes a strict JSON-only CLI without collapsing inconclusive evidence', () => {
    const root = repoFixture();
    const lines: string[] = [];
    const output = { log(value: string) { lines.push(value); } };

    expect(runHooksInstalledGuard(['--json'], root, output)).toBe(0);
    const passLine = lines.pop() ?? '';
    expect(passLine).not.toContain('\n');
    expect(JSON.parse(passLine)).toMatchObject({
      schemaVersion: 1,
      outcome: 'pass',
      exitCode: 0,
      code: 'ci.hooks.pass',
    });
    expect(runHooksInstalledGuard([], root, output)).toBe(2);
    const inputLine = lines.pop() ?? '';
    expect(inputLine).not.toContain('\n');
    expect(JSON.parse(inputLine)).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.hooks.input-invalid',
    });
    expect(runHooksInstalledGuard(['--json', '--json'], root, output)).toBe(2);
    expect(runHooksInstalledGuard(['--help'], root, output)).toBe(0);
    expect(runHooksInstalledGuard(['--help', '--bad'], root, output)).toBe(2);
  });

  it('executes the exact documented npm reproduction without duplicating JSON flags', () => {
    const root = repoFixture();
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const manifest = loadControlManifest(repoRoot);
    const reproduction = manifest.controls.find(({ id }) => id === 'ci.hooks.installed')?.remediation.reproduction;
    expect(reproduction).toBe('npm run guard:hooks-installed');
    expect(packageJson.scripts['guard:hooks-installed']?.match(/--json/g)).toHaveLength(1);
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'guard:hooks-installed': packageJson.scripts['guard:hooks-installed'] },
    }));
    symlinkSync(resolve(repoRoot, 'scripts'), resolve(root, 'scripts'));

    const result = spawnSync('bash', [resolve(repoRoot, 'scripts/run-with-pinned-npm.sh'), 'run', 'guard:hooks-installed'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...cleanGitEnv(),
        WHATSOUP_NODE: process.execPath,
        WHATSOUP_NPM: resolve(dirname(process.execPath), 'npm'),
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const receiptLines = result.stdout.split('\n').filter((line) => line.startsWith('{'));
    expect(receiptLines).toHaveLength(1);
    expect(parseHookIdentityReceiptBytes(Buffer.from(`${receiptLines[0]}\n`, 'utf8'))).toMatchObject({
      outcome: 'pass',
      exitCode: 0,
      code: 'ci.hooks.pass',
    });
  });

  it('validates, hashes, and serializes the native receipt through one exact contract', () => {
    const root = repoFixture();
    const result = inspectHookInstallation(root);

    expect(validateHookIdentityReceipt(result)).toEqual(result);
    const bytes = serializeHookIdentityReceipt(result);
    expect(bytes.at(-1)).toBe(0x0a);
    expect(Buffer.from(bytes).toString('utf8').split('\n')).toHaveLength(2);
    expect(parseHookIdentityReceiptBytes(bytes)).toEqual(result);

    expect(() => validateHookIdentityReceipt({ ...result, exitCode: 1 })).toThrow(/ci\.hooks\.receipt/);
    expect(() => validateHookIdentityReceipt({ ...result, code: 'ci.hooks.unknown' })).toThrow(/ci\.hooks\.receipt/);
    expect(() => validateHookIdentityReceipt({ ...result, unexpected: true })).toThrow(/ci\.hooks\.receipt/);
    expect(() => validateHookIdentityReceipt({ ...result, createdAt: '2026-07-21T00:00:00.000Z' })).toThrow(
      /ci\.hooks\.receipt\.digest-mismatch/,
    );
    const { evidenceDigest: _digest, ...content } = result;
    const invalidOidContent = {
      ...content,
      expectedOid: 'a'.repeat(41),
      observedHeadOid: 'a'.repeat(41),
    };
    expect(() => validateHookIdentityReceipt({
      ...invalidOidContent,
      evidenceDigest: hookIdentityEvidenceDigest(invalidOidContent),
    })).toThrow(/ci\.hooks\.receipt\.invalid-oid/);
    expect(() => validateHookIdentityReceipt({
      ...result,
      hooks: [result.hooks[1], result.hooks[0], ...result.hooks.slice(2)],
    })).toThrow(/ci\.hooks\.receipt/);
    expect(() => parseHookIdentityReceiptBytes(Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n'))).toThrow(
      /ci\.hooks\.receipt/,
    );
    expect(() => parseHookIdentityReceiptBytes(Buffer.from([0xff]))).toThrow(/ci\.hooks\.receipt/);
    expect(() => parseHookIdentityReceiptBytes(Buffer.alloc(MAX_HOOK_RECEIPT_BYTES + 1, 0x20))).toThrow(
      /ci\.hooks\.receipt/,
    );
    const hostile = { ...result } as Record<string, unknown>;
    Object.defineProperty(hostile, 'code', { enumerable: true, get: () => { throw new Error('raw secret'); } });
    expect(() => validateHookIdentityReceipt(hostile)).toThrow(/ci\.hooks\.receipt\.invalid-keys/);
    const hostileProxy = new Proxy(result, {
      ownKeys() { throw new Error('raw secret'); },
    });
    expect(() => validateHookIdentityReceipt(hostileProxy)).toThrow(/ci\.hooks\.receipt\.traversal-failed/);
    expect(() => validateHookIdentityReceipt({
      ...result,
      guidance: Array.from({ length: 9 }, () => 'bounded'),
    })).toThrow(/ci\.hooks\.receipt\.invalid-guidance/);
  });

  it('registers the report-only native guard without claiming hook authority', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const manifest = loadControlManifest(repoRoot);
    const control = manifest.controls.find(({ id }) => id === 'ci.hooks.installed');

    expect(packageJson.scripts['guard:hooks-installed']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/hooks-installed-guard.ts --json',
    );
    expect(manifest.canonicalCommands['guard:hooks-installed']).toEqual([
      'bash',
      'scripts/run-with-pinned-node.sh',
      'scripts/hooks-installed-guard.ts',
      '--json',
    ]);
    expect(control).toMatchObject({
      id: 'ci.hooks.installed',
      decisionOwner: 'hook-installation-decision-owner',
      mode: 'assist',
      implementation: {
        commandId: 'guard:hooks-installed',
        detectorId: 'hooks-installed-guard',
        nativeSchemaVersion: 1,
      },
    });
    expect(control?.failurePolicy.finding).toBe('block');
    expect([...HOOK_HELPERS, ...HOOK_ENTRYPOINTS]).toEqual([...REQUIRED_HOOK_PATHS]);
    expect(control?.evidence.paths).toEqual([...REQUIRED_HOOK_PATHS]);
    expect(manifest.riskRules.find(({ id }) => id === 'risk.control-policy')?.pathPrefixes).toEqual(
      expect.arrayContaining([
        'scripts/lib/verification/boundary-run/schema.ts',
        'scripts/lib/verification/boundary-run/shared.ts',
        'scripts/hooks-installed-guard.ts',
        'src/lib/git-env.ts',
        'tests/scripts/hooks-installed-guard.test.ts',
      ]),
    );
    expect(manifest.requiredSurfaces).toContain('hook-installation');
  });
});
