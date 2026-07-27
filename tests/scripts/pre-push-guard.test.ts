import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import {
  classifyPrePushInput,
  classifyPrePushLine,
  commandsForDecision,
  runPrePushGuard,
  ZERO_SHA,
} from '../../scripts/pre-push-guard.ts';
import {
  CI_EXEMPT_PUSH_GATE_GUARDS,
  namedInCi as namedInCiWorkflow,
  pushGateGuards as pushGateGuardsOf,
} from '../helpers/gate-membership.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prePushHook = resolve(repoRoot, '.husky/pre-push');
const pushGateScope = readFileSync(resolve(repoRoot, 'scripts/print-push-gate-scope.sh'), 'utf8');
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const vitestConfig = readFileSync(resolve(repoRoot, 'vitest.config.ts'), 'utf8');
const qualityWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8');
const qualityGuardrailsChecklist = readFileSync(
  resolve(repoRoot, 'docs/contributing/quality-guardrails-checklist.md'),
  'utf8',
);
const whatsoupGuardWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/whatsoup-guard.yml'), 'utf8');
const tagReleaseWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/tag-release-gate.yml'), 'utf8');
const guardPackageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'tools/whatsoup_guard/package.json'), 'utf8'),
) as { scripts: Record<string, string>; devDependencies?: Record<string, string> };

describe('pre-push guard classifier', () => {
  it('classifies delete-only ref updates as metadata-only', () => {
    expect(classifyPrePushLine(
      `refs/heads/topic ${ZERO_SHA} refs/heads/topic 40d37275dcb1c43decfb12e522f2d4f1b5e95a0c`,
    )).toBe('delete');
  });

  it('classifies main branch updates as release verification', () => {
    expect(classifyPrePushLine(
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    )).toBe('release');
  });

  it('classifies release tag updates as release verification', () => {
    expect(classifyPrePushLine(
      `refs/tags/v1.2.3 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/tags/v1.2.3 ${ZERO_SHA}`,
    )).toBe('release');
  });

  it('classifies feature branch updates as branch verification', () => {
    expect(classifyPrePushLine(
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
    )).toBe('branch');
  });

  it('skips verification when every ref update is delete-only', () => {
    const decision = classifyPrePushInput([
      `refs/heads/old-a ${ZERO_SHA} refs/heads/old-a 1111111111111111111111111111111111111111`,
      `refs/heads/old-b ${ZERO_SHA} refs/heads/old-b 2222222222222222222222222222222222222222`,
    ].join('\n'));

    expect(decision).toBe('skip');
    expect(commandsForDecision(decision)).toEqual([]);
  });

  it('uses branch verification for feature branch pushes', () => {
    const decision = classifyPrePushInput(
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
    );

    expect(decision).toBe('branch');
    expect(commandsForDecision(decision)).toEqual(['verify:push:branch']);
  });

  it('uses release verification when any pushed ref needs release treatment', () => {
    const decision = classifyPrePushInput([
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    ].join('\n'));

    expect(decision).toBe('release');
    expect(commandsForDecision(decision)).toEqual(['verify:release']);
  });

  it('rejects malformed pre-push ref lines', () => {
    expect(() => classifyPrePushLine('refs/heads/main only-two-fields')).toThrow(/Invalid pre-push/);
  });

  it('classifies force-update branch refs (real, differing shas) as branch verification', () => {
    // Regression guard: a force-update on a feature branch has a non-zero localSha
    // AND a non-zero, DIFFERENT remoteSha (unlike a new-branch push, where remoteSha
    // is ZERO_SHA). This already falls through to 'branch' — asserted here so the
    // empty-stdin fix below cannot accidentally start misrouting real force-pushes.
    expect(classifyPrePushLine(
      'refs/heads/feature/example aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/feature/example bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )).toBe('branch');
  });

  it('routes a main branch ref update alone to release verification', () => {
    const decision = classifyPrePushInput(
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    );
    expect(decision).toBe('release');
    expect(commandsForDecision(decision)).toEqual(['verify:release']);
  });

  it('does NOT silently skip when stdin has zero parseable ref-update lines (empty string)', () => {
    // Proven defect: classifyPrePushInput('') used to return 'skip' identically to
    // genuine all-delete input, so commandsForDecision(...) was [] and the entire
    // verification battery silently never ran on stdin starvation.
    const decision = classifyPrePushInput('');
    expect(decision).not.toBe('skip');
    expect(commandsForDecision(decision)).not.toEqual([]);
  });

  it('does NOT silently skip when stdin is whitespace-only', () => {
    const decision = classifyPrePushInput('   \n\t\n  \n');
    expect(decision).not.toBe('skip');
    expect(commandsForDecision(decision)).not.toEqual([]);
  });

  it('routes empty stdin to branch verification (fail closed)', () => {
    expect(classifyPrePushInput('')).toBe('branch');
    expect(commandsForDecision(classifyPrePushInput(''))).toEqual(['verify:push:branch']);
  });
  it('accepts exact 64-character SHA-256 object IDs', () => {
    expect(classifyPrePushLine(
      `refs/heads/feature/example ${'a'.repeat(64)} refs/heads/feature/example ${'b'.repeat(64)}`,
    )).toBe('branch');
  });

  it('classifies a 64-zero local object ID as a deletion', () => {
    const zeroSha256 = '0'.repeat(64);
    const input =
      `refs/heads/old-sha256 ${zeroSha256} refs/heads/old-sha256 ${'a'.repeat(64)}`;
    expect(classifyPrePushLine(input)).toBe('delete');
    expect(classifyPrePushInput(input)).toBe('skip');
  });

  it.each(Array.from({ length: 23 }, (_, index) => index + 41))(
    'rejects a %i-character local object ID between the supported SHA-1 and SHA-256 widths',
    (width) => {
      expect(() => classifyPrePushLine(
        `refs/heads/feature/example ${'a'.repeat(width)} refs/heads/feature/example ${'b'.repeat(40)}`,
      )).toThrow(/Invalid pre-push/);
    },
  );

  it.each(Array.from({ length: 23 }, (_, index) => index + 41))(
    'rejects a %i-character remote object ID between the supported SHA-1 and SHA-256 widths',
    (width) => {
      expect(() => classifyPrePushLine(
        `refs/heads/feature/example ${'a'.repeat(40)} refs/heads/feature/example ${'b'.repeat(width)}`,
      )).toThrow(/Invalid pre-push/);
    },
  );

});

describe('pre-push guard runtime — fail-closed on empty stdin', () => {
  const withStubNpm = (fn: (npmCallsLog: string, root: string) => void) => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-pre-push-guard-runtime-'));
    const bin = resolve(root, 'bin');
    const callsLog = resolve(root, 'npm-calls.log');
    const originalPath = process.env['PATH'];

    try {
      mkdirSync(bin, { recursive: true });
      const npmStub = resolve(bin, 'npm');
      writeFileSync(npmStub, [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> "${callsLog}"`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(npmStub, 0o755);
      process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
      fn(callsLog, root);
    } finally {
      if (originalPath === undefined) {
        delete process.env['PATH'];
      } else {
        process.env['PATH'] = originalPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('runs branch verification (not a silent skip) when stdin has zero parseable ref-update lines', () => {
    withStubNpm((callsLog) => {
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
        errors.push(String(msg));
      });
      try {
        const decision = runPrePushGuard('', repoRoot, {
          assertConsoleDependencies: () => {},
        });
        expect(decision).toBe('branch');
        expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
          'run guard:git-estate -- guard --phase pre-push',
          'run verify:push:branch',
        ]);
        expect(errors).toContain(
          'pre-push guard: no ref updates received on stdin — refusing to skip verification (fail-closed); genuine branch deletions still skip',
        );
        expect(errors).not.toContain(
          'pre-push guard: delete-only ref update; estate verified; running metadata verification',
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('runs branch verification for whitespace-only stdin too', () => {
    withStubNpm((callsLog) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const decision = runPrePushGuard('   \n\t\n  \n', repoRoot, {
          assertConsoleDependencies: () => {},
        });
        expect(decision).toBe('branch');
        expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
          'run guard:git-estate -- guard --phase pre-push',
          'run verify:push:branch',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('fails before branch and release verification when required console executables are missing', () => {
    for (const [input, expectedEstateCall] of [
      [
        `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
        'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
      ],
      [
        'refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5',
        'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/main',
      ],
    ]) {
      withStubNpm((callsLog, root) => {
        expect(() => runPrePushGuard(input, root)).toThrow(
          /missing required console executables: eslint, tsc, vite.*npm ci --prefix console/,
        );
        // The estate gate now runs before the console-dependency check, so the
        // call log is no longer empty — it must contain ONLY the estate-gate
        // invocation (the failed console check never reaches npm at all).
        expect(readFileSync(callsLog, 'utf8').trim()).toBe(expectedEstateCall);
      });
    }
  });

  const withConsoleTreeFixture = (
    state: 'broken' | 'valid',
    fn: (root: string, npmCallsLog: string, lifecycleMarker: string) => void,
  ) => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-pre-push-console-tree-'));
    const bin = resolve(root, 'bin');
    const callsLog = resolve(root, 'npm-calls.log');
    const lifecycleMarker = resolve(root, 'lifecycle-ran');
    const originalPath = process.env['PATH'];
    const originalNode = process.env['WHATSOUP_NODE'];
    const originalNpm = process.env['WHATSOUP_NPM'];
    const originalCache = process.env['npm_config_cache'];
    const originalRegistry = process.env['npm_config_registry'];

    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(resolve(root, 'scripts'), { recursive: true });
      mkdirSync(resolve(root, 'deploy/lib'), { recursive: true });
      mkdirSync(resolve(root, 'console/node_modules/.bin'), { recursive: true });
      mkdirSync(resolve(root, 'console/node_modules/fixture-parent'), { recursive: true });
      copyFileSync(
        resolve(repoRoot, 'scripts/run-with-pinned-npm.sh'),
        resolve(root, 'scripts/run-with-pinned-npm.sh'),
      );
      copyFileSync(
        resolve(repoRoot, 'deploy/lib/resolve-node.sh'),
        resolve(root, 'deploy/lib/resolve-node.sh'),
      );
      const runtimeMajor = Number(process.versions.node.split('.')[0]);
      writeFileSync(resolve(root, '.nvmrc'), `${process.versions.node}\n`);
      writeFileSync(
        resolve(root, 'package.json'),
        JSON.stringify({ engines: { node: `>=${runtimeMajor}.0.0 <${runtimeMajor + 1}` } }),
      );
      writeFileSync(
        resolve(root, 'console/package.json'),
        JSON.stringify({
          name: 'console-tree-fixture',
          version: '1.0.0',
          scripts: {
            preinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(lifecycleMarker)}, 'ran')"`,
          },
          dependencies: {
            'fixture-parent': '1.0.0',
          },
        }),
      );
      writeFileSync(
        resolve(root, 'console/node_modules/fixture-parent/package.json'),
        JSON.stringify({
          name: 'fixture-parent',
          version: '1.0.0',
          dependencies: {
            'fixture-child': '1.0.0',
          },
        }),
      );
      if (state === 'valid') {
        mkdirSync(
          resolve(root, 'console/node_modules/fixture-parent/node_modules/fixture-child'),
          { recursive: true },
        );
        writeFileSync(
          resolve(root, 'console/node_modules/fixture-parent/node_modules/fixture-child/package.json'),
          JSON.stringify({
            name: 'fixture-child',
            version: '1.0.0',
          }),
        );
      }

      for (const executable of ['eslint', 'tsc', 'vite']) {
        const target = resolve(root, 'console/node_modules/.bin', executable);
        writeFileSync(target, '#!/bin/sh\nexit 0\n');
        chmodSync(target, 0o755);
      }

      const npmStub = resolve(bin, 'npm');
      writeFileSync(npmStub, [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> "${callsLog}"`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(npmStub, 0o755);

      process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
      process.env['WHATSOUP_NODE'] = process.execPath;
      process.env['WHATSOUP_NPM'] = resolve(dirname(process.execPath), 'npm');
      process.env['npm_config_cache'] = resolve(root, 'npm-cache');
      process.env['npm_config_registry'] = 'http://127.0.0.1:9';
      fn(root, callsLog, lifecycleMarker);
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalNode === undefined) delete process.env['WHATSOUP_NODE'];
      else process.env['WHATSOUP_NODE'] = originalNode;
      if (originalNpm === undefined) delete process.env['WHATSOUP_NPM'];
      else process.env['WHATSOUP_NPM'] = originalNpm;
      if (originalCache === undefined) delete process.env['npm_config_cache'];
      else process.env['npm_config_cache'] = originalCache;
      if (originalRegistry === undefined) delete process.env['npm_config_registry'];
      else process.env['npm_config_registry'] = originalRegistry;
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('fails closed before the composite when all bins exist but the console dependency tree is broken', () => {
    withConsoleTreeFixture('broken', (root, callsLog, lifecycleMarker) => {
      const input = `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`;

      expect(() => runPrePushGuard(input, root)).toThrowError(
        new Error(
          'pre-push guard: console dependency tree is incomplete or invalid; run npm ci --prefix console before pushing',
        ),
      );
      // The estate gate now runs before the console-dependency check, so the
      // call log is no longer empty — it must contain ONLY the estate-gate
      // invocation (the broken tree throws before verify:push:branch runs).
      expect(readFileSync(callsLog, 'utf8').trim()).toBe(
        'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
      );
      expect(existsSync(lifecycleMarker)).toBe(false);
    });
  });

  it('validates a complete console tree offline without lifecycle scripts before running the composite', () => {
    withConsoleTreeFixture('valid', (root, callsLog, lifecycleMarker) => {
      const input = `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`;

      expect(runPrePushGuard(input, root)).toBe('branch');
      expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
        'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
        'run verify:push:branch',
      ]);
      expect(existsSync(lifecycleMarker)).toBe(false);
    });
  });

  it('runs metadata checks without console dependencies for genuine delete-only stdin', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-pre-push-delete-runtime-'));
    const bin = resolve(root, 'bin');
    const callsLog = resolve(root, 'bash-calls.log');
    const npmCallsLog = resolve(root, 'npm-calls.log');
    const originalPath = process.env['PATH'];

    try {
      mkdirSync(bin, { recursive: true });
      const bashStub = resolve(bin, 'bash');
      writeFileSync(bashStub, [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> "${callsLog}"`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(bashStub, 0o755);
      // The estate gate now runs before the delete-only metadata scripts and
      // invokes `npm` directly (not through bash), so it needs its own stub.
      const npmStub = resolve(bin, 'npm');
      writeFileSync(npmStub, [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> "${npmCallsLog}"`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(npmStub, 0o755);
      process.env['PATH'] = `${bin}:${originalPath ?? ''}`;

      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
        errors.push(String(msg));
      });
      const input = `refs/heads/old-a ${ZERO_SHA} refs/heads/old-a 1111111111111111111111111111111111111111`;
      try {
        const decision = runPrePushGuard(input, root);
        expect(decision).toBe('skip');
        expect(readFileSync(npmCallsLog, 'utf8').trim()).toBe(
          'run guard:git-estate -- guard --phase pre-push',
        );
        expect(existsSync(callsLog)).toBe(true);
        expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
          'scripts/run-with-pinned-npm.sh --prefix console run design:metrics',
          'scripts/run-with-pinned-npm.sh --prefix console run design:burndown',
        ]);
        expect(errors).toEqual([
          'pre-push guard: running deterministic Git estate gate',
          'pre-push guard: delete-only ref update; estate verified; running metadata verification',
        ]);
      } finally {
        spy.mockRestore();
      }
    } finally {
      if (originalPath === undefined) {
        delete process.env['PATH'];
      } else {
        process.env['PATH'] = originalPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('passes the nondeleted local branch ref to the estate gate for lane exemption', () => {
    withStubNpm((callsLog) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const input = `refs/heads/feature/example ${'a'.repeat(40)} refs/heads/feature/example ${ZERO_SHA}`;
        // This test is scoped to the estate-gate ref-passing behaviour, not the
        // console-dependency subprocess check (covered separately by the
        // withConsoleTreeFixture broken/valid pair below) — stub it out so a
        // real bash/npm resolution failure in the host environment can't leak
        // into an assertion this test never claims to make.
        const decision = runPrePushGuard(input, repoRoot, {
          assertConsoleDependencies: () => {},
        });
        expect(decision).toBe('branch');
        expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
          'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
          'run verify:push:branch',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('maps a symbolic HEAD push to its branch destination for lane exemption', () => {
    withStubNpm((callsLog) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const input =
          `HEAD ${'a'.repeat(40)} refs/heads/feature/example ${ZERO_SHA}`;
        const decision = runPrePushGuard(input, repoRoot, {
          assertConsoleDependencies: () => {},
        });
        expect(decision).toBe('branch');
        expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
          'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
          'run verify:push:branch',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('genuine delete-only stdin still runs the estate gate before skipping content verification', () => {
    withStubNpm((callsLog, root) => {
      // Delete-only pushes now also run the metadata scripts (design:metrics,
      // design:burndown) via bash after the estate gate; stub bash too so
      // those real invocations are captured deterministically.
      const bashCallsLog = resolve(root, 'bash-calls.log');
      const bashStub = resolve(root, 'bin', 'bash');
      writeFileSync(bashStub, [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> "${bashCallsLog}"`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(bashStub, 0o755);

      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
        errors.push(String(msg));
      });
      try {
        const input = `refs/heads/old-a ${ZERO_SHA} refs/heads/old-a 1111111111111111111111111111111111111111`;
        const decision = runPrePushGuard(input, repoRoot);
        expect(decision).toBe('skip');
        expect(readFileSync(callsLog, 'utf8').trim()).toBe(
          'run guard:git-estate -- guard --phase pre-push',
        );
        expect(readFileSync(bashCallsLog, 'utf8').trim().split('\n')).toEqual([
          'scripts/run-with-pinned-npm.sh --prefix console run design:metrics',
          'scripts/run-with-pinned-npm.sh --prefix console run design:burndown',
        ]);
        expect(errors).toEqual([
          'pre-push guard: running deterministic Git estate gate',
          'pre-push guard: delete-only ref update; estate verified; running metadata verification',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('accepts exact 64-character object IDs and passes the pushed branch to the estate gate', () => {
    withStubNpm((callsLog) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const input =
          `refs/heads/feature/sha256 ${'a'.repeat(64)} refs/heads/feature/sha256 ${'b'.repeat(64)}`;
        expect(runPrePushGuard(input, repoRoot, {
          assertConsoleDependencies: () => {},
        })).toBe('branch');
        expect(readFileSync(callsLog, 'utf8').trim().split('\n')).toEqual([
          'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/sha256',
          'run verify:push:branch',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('estate-gates a 64-zero delete-only update before skipping content verification', () => {
    withStubNpm((callsLog, root) => {
      // Delete-only pushes now also run the metadata scripts (design:metrics,
      // design:burndown) via bash after the estate gate; stub bash too so
      // those real invocations are captured deterministically.
      const bashCallsLog = resolve(root, 'bash-calls.log');
      const bashStub = resolve(root, 'bin', 'bash');
      writeFileSync(bashStub, [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> "${bashCallsLog}"`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(bashStub, 0o755);

      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
        errors.push(String(msg));
      });
      try {
        const input =
          `refs/heads/old-sha256 ${'0'.repeat(64)} refs/heads/old-sha256 ${'a'.repeat(64)}`;
        expect(runPrePushGuard(input, repoRoot)).toBe('skip');
        expect(readFileSync(callsLog, 'utf8').trim()).toBe(
          'run guard:git-estate -- guard --phase pre-push',
        );
        expect(readFileSync(bashCallsLog, 'utf8').trim().split('\n')).toEqual([
          'scripts/run-with-pinned-npm.sh --prefix console run design:metrics',
          'scripts/run-with-pinned-npm.sh --prefix console run design:burndown',
        ]);
        expect(errors).toEqual([
          'pre-push guard: running deterministic Git estate gate',
          'pre-push guard: delete-only ref update; estate verified; running metadata verification',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('runs the estate gate before rejecting malformed ref input', () => {
    withStubNpm((callsLog) => {
      expect(() => runPrePushGuard('malformed', repoRoot)).toThrow(/Invalid pre-push/);
      expect(readFileSync(callsLog, 'utf8').trim()).toBe(
        'run guard:git-estate -- guard --phase pre-push',
      );
    });
  });

  it('preserves the estate child exit code so INCONCLUSIVE is not flattened to a generic failure', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-pre-push-estate-exit-'));
    const bin = resolve(root, 'bin');
    const npmStub = resolve(bin, 'npm');
    try {
      mkdirSync(bin, { recursive: true });
      writeFileSync(npmStub, '#!/bin/sh\nexit 2\n');
      chmodSync(npmStub, 0o755);
      const proc = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--experimental-strip-types',
          resolve(repoRoot, 'scripts/pre-push-guard.ts'),
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
          input: `refs/heads/feature/example ${'a'.repeat(40)} refs/heads/feature/example ${ZERO_SHA}\n`,
        },
      );

      expect(proc.status, proc.stderr).toBe(2);
      expect(proc.stderr).toContain('pre-push guard: running deterministic Git estate gate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([41, 52, 63])(
    'runs the estate gate before rejecting a %i-character object ID',
    (width) => {
      withStubNpm((callsLog) => {
        const input =
          `refs/heads/feature/example ${'a'.repeat(width)} refs/heads/feature/example ${'b'.repeat(40)}`;
        expect(() => runPrePushGuard(input, repoRoot)).toThrow(/Invalid pre-push/);
        expect(readFileSync(callsLog, 'utf8').trim()).toBe(
          'run guard:git-estate -- guard --phase pre-push',
        );
      });
    },
  );

});

describe('pre-push hook runtime isolation', () => {
  it('clears repository-local Git state and runs every command through the pinned wrappers', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-pre-push-hook-'));
    const bin = resolve(root, 'bin');
    const calls = resolve(root, 'calls.log');
    const environments = resolve(root, 'environments.log');
    const stdin = resolve(root, 'stdin.log');
    const refUpdate = 'refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5';

    try {
      mkdirSync(bin, { recursive: true });

      const writeExecutable = (name: string, body: string) => {
        const target = resolve(bin, name);
        writeFileSync(target, body);
        chmodSync(target, 0o755);
      };

      writeExecutable('git', [
        '#!/bin/sh',
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--local-env-vars" ]; then',
        '  printf "%s\\n" "GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX"',
        '  exit 0',
        'fi',
        'exit 97',
        '',
      ].join('\n'));
      writeExecutable('bash', [
        '#!/bin/sh',
        'printf "bash %s\\n" "$*" >> "$HOOK_CALLS"',
        'printf "%s|%s|%s|%s\\n" "${GIT_DIR-unset}" "${GIT_WORK_TREE-unset}" "${GIT_INDEX_FILE-unset}" "${GIT_PREFIX-unset}" >> "$HOOK_ENVIRONMENTS"',
        'if [ "$1" = "scripts/run-with-pinned-node.sh" ]; then',
        '  IFS= read -r line || true',
        '  printf "%s\\n" "$line" >> "$HOOK_STDIN"',
        'fi',
        'exit 0',
        '',
      ].join('\n'));
      for (const ambient of ['node', 'npm']) {
        writeExecutable(ambient, [
          '#!/bin/sh',
          `printf "AMBIENT-${ambient} %s\\n" "$*" >> "$HOOK_CALLS"`,
          'exit 0',
          '',
        ].join('\n'));
      }

      const result = spawnSync('sh', [prePushHook], {
        cwd: repoRoot,
        encoding: 'utf8',
        input: `${refUpdate}\n`,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: process.env['HOME'] ?? tmpdir(),
          HOOK_CALLS: calls,
          HOOK_ENVIRONMENTS: environments,
          HOOK_STDIN: stdin,
          GIT_DIR: '/poison/source.git',
          GIT_WORK_TREE: '/poison/source-tree',
          GIT_INDEX_FILE: '/poison/source.index',
          GIT_PREFIX: 'poison-prefix/',
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
        'bash scripts/run-with-pinned-node.sh scripts/pre-push-guard.ts',
      ]);
      expect(readFileSync(environments, 'utf8').trim().split('\n')).toEqual([
        'unset|unset|unset|unset',
      ]);
      expect(readFileSync(stdin, 'utf8').trim()).toBe(refUpdate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before verification when Git-local environment discovery is inconclusive', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-pre-push-hook-failure-'));
    const bin = resolve(root, 'bin');
    const calls = resolve(root, 'calls.log');

    try {
      mkdirSync(bin, { recursive: true });
      const git = resolve(bin, 'git');
      writeFileSync(git, '#!/bin/sh\nexit 75\n');
      chmodSync(git, 0o755);
      for (const command of ['bash', 'node', 'npm']) {
        const target = resolve(bin, command);
        writeFileSync(target, [
          '#!/bin/sh',
          'printf "%s\\n" "$0 $*" >> "$HOOK_CALLS"',
          'exit 0',
          '',
        ].join('\n'));
        chmodSync(target, 0o755);
      }

      const result = spawnSync('sh', [prePushHook], {
        cwd: repoRoot,
        encoding: 'utf8',
        input: 'refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5\n',
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: process.env['HOME'] ?? tmpdir(),
          HOOK_CALLS: calls,
          GIT_DIR: '/poison/source.git',
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unable to resolve repository-local Git environment');
      expect(existsSync(calls)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verify chain composition (package.json)', () => {
  it('exposes one production semantic command with explicit enforce and shadow adapters', () => {
    expect(packageJson.scripts['guard:semantic-quality']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/semantic-quality-check.ts',
    );
    expect(packageJson.scripts['verify:semantic']).toBe(
      'npm run guard:semantic-quality -- --mode enforce',
    );
    expect(packageJson.scripts['verify:semantic:shadow']).toBe(
      'npm run guard:semantic-quality -- --mode shadow',
    );
  });

  it('runs semantic shadow feedback before the expensive local push and release suites', () => {
    const push = packageJson.scripts['verify:push:branch'];
    const release = packageJson.scripts['verify:release'];
    expect(push).toContain('npm run verify:semantic:shadow');
    expect(release).toContain('npm run verify:semantic:shadow');
    expect(push.indexOf('npm run verify:semantic:shadow')).toBeLessThan(push.indexOf('npm test'));
    expect(release.indexOf('npm run verify:semantic:shadow')).toBeLessThan(
      release.indexOf('npm run coverage:check'),
    );
  });

  it('runs TypeScript package entrypoints through the pinned Node wrapper', () => {
    const directAmbientScripts = Object.entries(packageJson.scripts)
      .filter(([, command]) => /\bnode\s+--experimental-strip-types\b/.test(command))
      .map(([scriptName]) => scriptName);

    expect(directAmbientScripts).toEqual([]);
  });

  it('verify:push:branch invokes guard:work-index', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:work-index\b/);
  });

  it('documents ARC binding drift as enforced in both local pre-push and CI quality', () => {
    expect(qualityWorkflow).toContain('run: npm run guard:arc-binding-drift');
    expect(qualityGuardrailsChecklist).toMatch(
      /\| ARC binding drift \| `npm run guard:arc-binding-drift` \|[^\n]+\| yes \|/,
    );
  });

  it('verify:push:branch invokes staged publication guard', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:publication:staged\b/);
  });

  it('verify:release invokes guard:work-index', () => {
    // Regression guard for #495: verify:release was missing the work-index
    // step that verify:push:branch and CI quality.yml both run, allowing
    // work-index drift to land on main without local detection.
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:work-index\b/);
  });

  it('verify:release invokes the test-integrity baseline gate', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:test-integrity\b/);
  });

  it('verify chains invoke the agent decision polls protocol guard', () => {
    for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:agent-decision-polls\b/);
    }
  });

  it('verify:push:branch invokes the test-integrity baseline gate', () => {
    // Regression guard: PR #677 surfaced that verify:push:branch did NOT run
    // guard:test-integrity, so a weak-assertion violation slipped past the
    // local pre-push hook and was caught only by CI. The CI quality job runs
    // this gate; the local push gate must too so the dev cycle is fail-fast.
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:test-integrity\b/);
  });

  it('runs the catch-ratchet drift gate in push, release, and CI paths', () => {
    const push = packageJson.scripts['verify:push:branch'] ?? '';
    const release = packageJson.scripts['verify:release'] ?? '';

    expect(push).toMatch(/\bnpm run guard:catch-ratchet\b/);
    expect(release).toMatch(/\bnpm run guard:catch-ratchet\b/);
    expect(qualityWorkflow).toMatch(/\bnpm run guard:catch-ratchet\b/);
  });

  it('verify:push:branch invokes the fast CI-only checks that drove local-green/CI-red (#1105)', () => {
    // Regression guard for #1105: verify:push:branch omitted console lint/build,
    // guard:design-system-hygiene, guard:harness-maintenance, and test:tokenomics —
    // all blocking steps in the CI quality job — so violations in those surfaces
    // (e.g. console noUnusedLocals/verbatimModuleSyntax, design-system drift,
    // harness node-pin drift, tokenomics regressions) passed the local push gate
    // and failed only in CI. These are fast+deterministic; the slow coverage/
    // drills/browser tail intentionally stays in verify:release (asserted below).
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:design-system-hygiene\b/);
    expect(chain).toMatch(/\bnpm run guard:harness-maintenance\b/);
    expect(chain).toMatch(/\bnpm run test:tokenomics\b/);
    expect(chain).toMatch(/--prefix console run lint\b/);
    expect(chain).toMatch(/--prefix console run build\b/);
  });

  it('quality.yml console lint + build steps are mirrored by the local push gate (#1105)', () => {
    // The CI quality workflow runs console lint + build as blocking steps; the
    // local gate must mirror them so console strict-tsconfig violations fail fast.
    expect(qualityWorkflow).toMatch(/--prefix console run lint/);
    expect(qualityWorkflow).toMatch(/--prefix console run build/);
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain).toMatch(/--prefix console run lint\b/);
    expect(chain).toMatch(/--prefix console run build\b/);
  });

  it('verify:release retains the slow coverage/browser tail intentionally omitted from the push gate (#1105)', () => {
    // Documents the intentional split: the full-suite coverage gate and the
    // browser suites stay in verify:release (and CI), not the fast push gate.
    const release = packageJson.scripts['verify:release'];
    expect(release, 'verify:release script must exist').toBeDefined();
    expect(release).toMatch(/\bnpm run coverage:check\b/);
    expect(release).toMatch(/\bnpm run verify:console-browser\b/);
  });

  it('verify:release runs the root full suite once through serialized coverage', () => {
    const release = packageJson.scripts['verify:release'];
    expect(release, 'verify:release script must exist').toBeDefined();

    const rootFullSuitePatterns = [
      /^npm (?:test|run test)(?:\s|$)/,
      /^npm run coverage(?::check)?(?:\s|$)/,
      /^bash scripts\/run-coverage-check\.sh(?:\s|$)/,
    ];
    const rootFullSuiteCommands = release
      .split(/\s*&&\s*/)
      .filter((command) => rootFullSuitePatterns.some((pattern) => pattern.test(command)));

    expect(rootFullSuiteCommands).toEqual([
      'npm run coverage:check -- --pool=forks --fileParallelism=false',
    ]);
  });

  it('shared console design verification invokes design guard fixture tests', () => {
    const chain = packageJson.scripts['verify:console-design'];
    expect(chain, 'verify:console-design script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run test:design-guards\b/);
  });

  it('runs design metadata checks exactly once for branch and release verification', () => {
    const sharedDesign = packageJson.scripts['verify:console-design'];
    const hookSource = readFileSync(prePushHook, 'utf8');

    for (const scriptName of ['design:metrics', 'design:burndown']) {
      expect(sharedDesign.match(new RegExp(`run ${scriptName}`, 'g')) ?? []).toHaveLength(1);
      expect(hookSource).not.toContain(`run ${scriptName}`);
    }
    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      expect(packageJson.scripts[scriptName].match(/npm run verify:console-design/g) ?? []).toHaveLength(1);
    }
  });

  it('describes stable push-gate scope and distinguishes manual invocation from the hook dispatcher', () => {
    expect(pushGateScope).not.toMatch(/typecheck x\d+/);
    expect(pushGateScope).not.toMatch(/~\d+-file test subset/);
    expect(pushGateScope).toContain('targeted test subset');
    expect(pushGateScope).toContain('manual npm run verify:push:branch bypasses ref classification');
    expect(pushGateScope).toContain('installed hook invokes pre-push-guard.ts');
    expect(pushGateScope).toContain('delete-only runs design metadata checks only');
  });

  it('design guard fixture lane covers the scanner contracts used by console design verification', () => {
    const chain = packageJson.scripts['test:design-guards'];
    expect(chain, 'test:design-guards script must exist').toBeDefined();
    expect(chain).toContain('npm test -- ');
    expect(chain).toContain('--pool=forks');
    for (const testFile of [
      'tests/scripts/theme-parity.test.ts',
      'tests/scripts/token-spec-drift.test.ts',
      'tests/scripts/contrast-matrix.test.ts',
      'tests/scripts/shadow-baseline.test.ts',
      'tests/scripts/shadow-frozen-inventory.test.ts',
      'tests/scripts/raw-form-control-inventory.test.ts',
      'tests/scripts/design-regression-guards.test.ts',
      'tests/scripts/design-metrics.test.ts',
      'tests/scripts/design-burndown-check.test.ts',
      'tests/scripts/color-semantics.test.ts',
      'tests/scripts/design-resilience-audit.test.ts',
      'tests/scripts/font-assets.test.ts',
      'tests/scripts/brand-assets.test.ts',
      'tests/scripts/design-lint-fixtures.test.ts',
    ]) {
      expect(chain).toContain(testFile);
    }
  });

  it('verify chains invoke the commit-author guard', () => {
    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:repo:commit-authors\b/);
    }
  });

  it('verify:push:branch invokes branch-diff repo hygiene after staged smoke', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:repo:staged\b/);
    expect(chain).toMatch(/\bnpm run guard:repo:branch-diff\b/);
    expect(chain.indexOf('npm run guard:repo:staged')).toBeLessThan(
      chain.indexOf('npm run guard:repo:branch-diff'),
    );
    expect(chain.indexOf('npm run guard:repo:branch-diff')).toBeLessThan(
      chain.indexOf('npm run guard:repo:commit-authors'),
    );
  });

  it('verify chains invoke BOT ERRORS runtime-source, runtime-manifest, and simulation-matrix guards', () => {
    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:source-runtime-drift\b/);
      expect(chain).toMatch(/\bnpm run guard:bot-errors-runtime-manifest\b/);
      expect(chain).toMatch(/\bnpm run guard:bot-errors-simulation-matrix\b/);
      expect(chain.indexOf('npm run guard:source-runtime-drift')).toBeLessThan(
        chain.indexOf('npm run guard:bot-errors-runtime-manifest'),
      );
      expect(chain.indexOf('npm run guard:bot-errors-runtime-manifest')).toBeLessThan(
        chain.indexOf('npm run guard:bot-errors-simulation-matrix'),
      );
      expect(chain).not.toMatch(/\bnpm run guard:bot-errors-critical-surfaces\b/);
    }
  });

  it('verify:push:branch invokes full test typecheck, not source-only typecheck', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run typecheck:all\b/);
    expect(chain).not.toMatch(/\bnpm run typecheck(?:\s|&&|$)/);
  });

  it('verify:release invokes the standalone whatsoup guard package checks', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix tools\/whatsoup_guard ci\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix tools\/whatsoup_guard run typecheck\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix tools\/whatsoup_guard test\b/);
    expect(chain).not.toMatch(/\bnpm --prefix tools\/whatsoup_guard\b/);
    expect(chain).not.toMatch(/\btools\/whatsoup_guard run coverage:proof\b/);
  });

  it('root coverage excludes the standalone whatsoup guard package', () => {
    expect(vitestConfig).toContain('coverageConfigDefaults.exclude');
    expect(vitestConfig).toContain("'tools/whatsoup_guard/**'");
  });

  it('verify:release invokes full publication audit guard', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:publication:all\b/);
    expect(chain).not.toMatch(/\bnpm run guard:publication:release\b/);
  });

  it('verify:release invokes release repo hygiene guard', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:repo:release-hygiene\b/);
  });

  it('verify:publish invokes strict publication release guard before release verification', () => {
    const chain = packageJson.scripts['verify:publish'];
    expect(chain, 'verify:publish script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:publication:release\b/);
    expect(chain).toMatch(/\bnpm run verify:release\b/);
    expect(chain.indexOf('npm run guard:publication:release')).toBeLessThan(
      chain.indexOf('npm run verify:release'),
    );
  });

  it('verify:release invokes console lint', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix console ci\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix console run lint\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix console run build\b/);
    expect(chain).not.toMatch(/\bnpm --prefix console\b/);
  });

  it('exposes coverage headroom as an explicit guard script', () => {
    expect(packageJson.scripts['guard:coverage-headroom']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/check-coverage-headroom.ts',
    );
  });

  it('coverage thresholds are scoped to production source files', () => {
    expect(vitestConfig).toContain("include: ['src/**/*.ts', 'src/**/*.tsx']");
  });
});

describe('quality workflow composition', () => {
  it('runs one read-only Node 24 semantic shadow step before integrity and expensive suites', () => {
    const semanticMatches = qualityWorkflow.match(/name: Semantic quality \(shadow\)/g) ?? [];
    const semanticIndex = qualityWorkflow.indexOf('name: Semantic quality (shadow)');
    const integrityInstallIndex = qualityWorkflow.indexOf('name: Install test-integrity plugin');
    const suiteIndex = qualityWorkflow.indexOf('name: Test suite + coverage thresholds');

    expect(semanticMatches).toHaveLength(1);
    expect(semanticIndex).toBeGreaterThanOrEqual(0);
    expect(semanticIndex).toBeLessThan(integrityInstallIndex);
    expect(semanticIndex).toBeLessThan(suiteIndex);
    expect(qualityWorkflow).toContain('name: quality (24.x)');
    expect(qualityWorkflow).not.toContain("if: matrix.node == '24.x'");
    expect(qualityWorkflow).toContain('SEMANTIC_RECEIPT: ${{ runner.temp }}/semantic-quality.json');
    expect(qualityWorkflow).toContain('base="origin/$GITHUB_BASE_REF"');
    expect(qualityWorkflow).toContain('base="HEAD^"');
    expect(qualityWorkflow).toContain('--mode shadow --base "$base" --receipt "$SEMANTIC_RECEIPT"');
    expect(qualityWorkflow).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(qualityWorkflow).toMatch(/permissions:\n  contents: read/);
    expect(qualityWorkflow).not.toContain('pull_request_target');
    expect(qualityWorkflow).not.toContain('path: semantic-quality.json');
  });

  it('installs the private test-integrity plugin before requiring the baseline gate', () => {
    const installIndex = qualityWorkflow.indexOf('name: Install test-integrity plugin');
    const gateIndex = qualityWorkflow.indexOf('name: Test integrity baseline check');

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(installIndex);
    expect(qualityWorkflow).toContain('TEST_INTEGRITY_DEPLOY_KEY');
    expect(qualityWorkflow).toContain('LucasQuiles/test-integrity.git');
    expect(qualityWorkflow).toContain('TEST_INTEGRITY_COMMIT: ea0b01a4e3d99dc58a9a475c57e22ee204b04a7c');
    expect(qualityWorkflow).toContain('mkdir -p "$plugin_dir" "$HOME/.ssh"');
    expect(qualityWorkflow).toContain('fetch --depth 1 origin "$TEST_INTEGRITY_COMMIT"');
    expect(qualityWorkflow).toContain('if [ "$observed_commit" != "$TEST_INTEGRITY_COMMIT" ]; then');
    expect(qualityWorkflow).not.toContain('git clone --depth 1');
    expect(qualityWorkflow).not.toMatch(/git -C "\$plugin_dir" push/);
    expect(qualityWorkflow).toContain("WHATSOUP_REQUIRE_TEST_INTEGRITY: '1'");
  });

  it('sets up Python 3.12 with pytest-cov before Python-backed gates run', () => {
    const setupPythonIndex = qualityWorkflow.indexOf('name: Setup Python 3.12');
    const pythonDepsIndex = qualityWorkflow.indexOf('name: Install Python and Linux quality prerequisites');
    const testIntegrityIndex = qualityWorkflow.indexOf('name: Test integrity baseline check');

    expect(setupPythonIndex).toBeGreaterThanOrEqual(0);
    expect(pythonDepsIndex).toBeGreaterThan(setupPythonIndex);
    expect(testIntegrityIndex).toBeGreaterThan(pythonDepsIndex);
    expect(qualityWorkflow).toMatch(/uses: actions\/setup-python@[0-9a-f]{40}/);
    expect(qualityWorkflow).toContain("python-version: '3.12'");
    expect(qualityWorkflow).toContain('python3 -m pip install --user pytest pytest-cov hypothesis ruff==0.15.10');
    expect(qualityWorkflow.match(/sudo apt-get update/g)).toHaveLength(2);
    expect(qualityWorkflow).toContain('sudo apt-get install -y shellcheck ripgrep');
  });

  it('preserves exact required contexts while isolating Node 25 compatibility work', () => {
    const compatibilityStart = qualityWorkflow.indexOf('  compatibility:');
    const nextJob = qualityWorkflow.indexOf('  bot-errors-health-macos:', compatibilityStart);
    const compatibility = qualityWorkflow.slice(compatibilityStart, nextJob);

    expect(qualityWorkflow).toContain('name: quality (24.x)');
    expect(compatibility).toContain('name: quality (25.x)');
    expect(qualityWorkflow).not.toContain('matrix:');
    expect(compatibility).toContain("node-version: '25.x'");
    expect(compatibility).toContain('run: npm test -- --pool=forks');
    expect(compatibility).toContain('run: npm --prefix console run build');
    expect(compatibility).not.toContain('coverage:check');
    expect(compatibility).not.toContain('guard:');
    expect(compatibility).not.toContain('Playwright');
    expect(compatibility).not.toContain('Setup Python');
    expect(compatibility).not.toContain('test-integrity');
    expect(compatibility).not.toContain('ci-disk-reclaim');
  });

  it('runs measured disk enforcement only in the Node 24 authority job', () => {
    expect(qualityWorkflow.match(/bash scripts\/ci-disk-reclaim\.sh/g)).toHaveLength(1);
    expect(qualityWorkflow).not.toContain('sudo rm -rf /usr/share/dotnet');
    expect(qualityWorkflow).not.toContain('docker image prune --all --force || true');
  });

  it('runs the commit-author guard in CI quality workflow', () => {
    expect(qualityWorkflow).toContain('npm run guard:repo:commit-authors');
  });

  it('runs branch-diff repo hygiene in CI before commit-author scanning', () => {
    const branchDiffIndex = qualityWorkflow.indexOf('npm run guard:repo:branch-diff');
    const commitAuthorIndex = qualityWorkflow.indexOf('npm run guard:repo:commit-authors');

    expect(branchDiffIndex).toBeGreaterThanOrEqual(0);
    expect(commitAuthorIndex).toBeGreaterThan(branchDiffIndex);
    expect(qualityWorkflow).toContain('--base "origin/$GITHUB_BASE_REF"');
  });

  it('fetches one fail-closed PR base snapshot before every authority consumer', () => {
    const compatibilityIndex = qualityWorkflow.indexOf('  compatibility:');
    const authority = qualityWorkflow.slice(0, compatibilityIndex);
    const fetchCommand =
      'git fetch origin "$GITHUB_BASE_REF:refs/remotes/origin/$GITHUB_BASE_REF"';
    const fetchLines = authority
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes('git fetch')
          && line.includes('refs/remotes/origin/$GITHUB_BASE_REF'),
      );
    const fetchIndex = authority.indexOf(fetchCommand);
    const snapshotStepIndex = authority.indexOf('- name: Refresh PR base snapshot');
    const semanticStepIndex = authority.indexOf('- name: Semantic quality (shadow)');
    const snapshotStep = authority.slice(snapshotStepIndex, semanticStepIndex);
    const consumerCommands = [
      'npm run guard:semantic-quality -- --mode shadow --base "$base"',
      'npm run guard:repo:branch-diff',
      'npm run guard:repo:commit-authors',
      'npm run guard:baseline-growth',
      'npm run guard:design-system-hygiene -- --changed-since "origin/${GITHUB_BASE_REF}"',
    ];

    expect(compatibilityIndex).toBeGreaterThanOrEqual(0);
    expect(fetchLines).toEqual([fetchCommand]);
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotStepIndex).toBeGreaterThanOrEqual(0);
    expect(semanticStepIndex).toBeGreaterThan(snapshotStepIndex);
    expect(snapshotStep).toContain(fetchCommand);
    expect(snapshotStep).not.toMatch(/continue-on-error|set \+e|\|\| true/);
    for (const command of consumerCommands) {
      expect(authority.indexOf(command)).toBeGreaterThan(fetchIndex);
    }
  });

  it('relies on authoritative coverage instead of rerunning repo-hygiene tests', () => {
    const compatibilityIndex = qualityWorkflow.indexOf('  compatibility:');
    const authority = qualityWorkflow.slice(0, compatibilityIndex);
    const stagedIndex = authority.indexOf('npm run guard:repo:staged');
    const branchDiffIndex = authority.indexOf('npm run guard:repo:branch-diff');
    const commitAuthorIndex = authority.indexOf('npm run guard:repo:commit-authors');
    const coverageIndex = authority.indexOf('npm run coverage:check -- --pool=forks');

    expect(compatibilityIndex).toBeGreaterThanOrEqual(0);
    expect(stagedIndex).toBeGreaterThanOrEqual(0);
    expect(branchDiffIndex).toBeGreaterThan(stagedIndex);
    expect(commitAuthorIndex).toBeGreaterThan(branchDiffIndex);
    expect(coverageIndex).toBeGreaterThan(commitAuthorIndex);
    expect(authority).not.toContain(
      'run: npm test -- tests/scripts/repo-hygiene-guard.test.ts --pool=forks',
    );
  });

  it('runs BOT ERRORS runtime manifest verification before the simulation matrix in CI', () => {
    const runtimeManifestIndex = qualityWorkflow.indexOf('npm run guard:bot-errors-runtime-manifest');
    const simulationIndex = qualityWorkflow.indexOf('npm run guard:bot-errors-simulation-matrix');

    expect(runtimeManifestIndex).toBeGreaterThanOrEqual(0);
    expect(simulationIndex).toBeGreaterThan(runtimeManifestIndex);
  });

  it('runs the sentinel coverage and deployer mutation gate in CI after the simulation matrix', () => {
    const simulationIndex = qualityWorkflow.indexOf('npm run guard:bot-errors-simulation-matrix');
    const sentinelGateIndex = qualityWorkflow.indexOf('bash deploy/scripts/run-sentinel-tests.sh');
    const testSuiteIndex = qualityWorkflow.indexOf('name: Test suite');

    expect(simulationIndex).toBeGreaterThanOrEqual(0);
    expect(sentinelGateIndex).toBeGreaterThan(simulationIndex);
    expect(testSuiteIndex).toBeGreaterThan(sentinelGateIndex);
    expect(qualityWorkflow).toContain('name: BOT ERRORS sentinel coverage and deployer mutation gate');
  });

  it('runs the standalone guard package test workflow', () => {
    expect(whatsoupGuardWorkflow).toContain('run: npm test');
    expect(whatsoupGuardWorkflow).not.toContain('npm run coverage:proof');
  });

  it('documents tag commit-author gate range semantics without changing enforcement', () => {
    const commentIndex = tagReleaseWorkflow.indexOf('keeps guard:repo:commit-authors wired on tag pushes');
    const stepIndex = tagReleaseWorkflow.indexOf('name: Repo commit-authors');

    expect(commentIndex).toBeGreaterThanOrEqual(0);
    expect(stepIndex).toBeGreaterThan(commentIndex);
    expect(tagReleaseWorkflow).toContain('PR and local push gates remain the authoritative non-vacuous author scans.');
    expect(tagReleaseWorkflow).toContain('run: npm run guard:repo:commit-authors');
  });
});

/**
 * Local push gate ⊄ CI: a guard that runs ONLY in `verify:push:branch` is enforced by a
 * client-side hook, and client-side hooks are advisory. `gh pr merge`, the GitHub merge
 * button, `--no-verify`, or a clone where husky was never installed all bypass it entirely.
 *
 * Real instance (2026-07-22): `guard:transport-patterns` backed three `severity: 'block'`
 * registry rules — `hygiene.no-wa-jid-literal-in-generic-ui`,
 * `hygiene.no-whatsapp-copy-in-generic-ui`, `hygiene.no-health-whatsapp-key-read` — and
 * appeared in NO workflow and not in `verify:release`. Its only CI-executed test asserted
 * `violations.length > 0`, a smoke test that passes just as happily with MORE violations.
 * So a PR merged through the UI could ship a new violation of a block rule with nothing
 * catching it. It is now a named step in `quality.yml`.
 *
 * A guard may legitimately have no named CI step when something else runs the same
 * assertion on the live tree inside the full suite (which CI runs via `coverage:check`).
 * That is fine — but it must be STATED, not assumed, which is what the exemption map is
 * for. The second test deletes stale entries by failing when an exemption is no longer
 * needed, so the map cannot quietly become a list of excuses.
 */
/**
 * The exemption map and the two membership predicates now live in
 * `tests/helpers/gate-membership.ts`, because a second suite needs the same answer:
 * `fitness-registry-backing.test.ts` asks whether each `severity: 'block'` registry rule
 * names a backstop a server-side merge cannot bypass. Two independent definitions of
 * "gate-reachable" would drift, and a drifting protection claim is precisely the failure
 * this file was written to catch — so there is one definition and both suites import it.
 */
describe('pre-push guard — local/CI enforcement parity for guard steps', () => {
  const pushGateGuards = pushGateGuardsOf(packageJson.scripts);
  const namedInCi = (guard: string): boolean => namedInCiWorkflow(guard, qualityWorkflow);

  it('the push gate actually contains guards (the scan is not vacuous)', () => {
    expect(pushGateGuards.length).toBeGreaterThan(20);
  });

  it('every push-gate guard is either a named CI step or an explicitly justified exemption', () => {
    const unbacked = pushGateGuards.filter((g) => !namedInCi(g) && !(g in CI_EXEMPT_PUSH_GATE_GUARDS));
    expect(
      unbacked,
      unbacked.length === 0
        ? ''
        : `These guards run ONLY in the local push gate, which any server-side merge bypasses:\n` +
          unbacked.map((g) => `  - ${g}`).join('\n') +
          `\nAdd a named step to .github/workflows/quality.yml, or add an entry to ` +
          `CI_EXEMPT_PUSH_GATE_GUARDS naming the live-tree test that enforces it in the full suite.`,
    ).toEqual([]);
  });

  it('no stale exemptions — an exempted guard that gained a CI step must leave the map', () => {
    const nowRedundant = Object.keys(CI_EXEMPT_PUSH_GATE_GUARDS).filter((g) => namedInCi(g));
    expect(
      nowRedundant,
      `These now have a named CI step, so their exemption is obsolete — delete it: ${nowRedundant.join(', ')}`,
    ).toEqual([]);
  });

  it('every exemption names a real guard that the push gate actually runs', () => {
    const orphaned = Object.keys(CI_EXEMPT_PUSH_GATE_GUARDS).filter((g) => !pushGateGuards.includes(g));
    expect(orphaned, `exemptions for guards not in verify:push:branch: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('guard:transport-patterns has a named CI step (the block rules it backs are not hook-only)', () => {
    // The specific regression. Three severity:'block' rules depended on a client-side hook.
    expect(qualityWorkflow).toMatch(/npm run guard:transport-patterns/);
  });

  it('every exemption that claims a backing test names a file that EXISTS', () => {
    // Without this, deleting the backing test silently converts a justified exemption into
    // an unenforced guard — the map would keep asserting coverage that no longer exists.
    const missing = Object.entries(CI_EXEMPT_PUSH_GATE_GUARDS)
      .filter(([, v]) => v.backedBy !== null)
      .filter(([, v]) => !existsSync(resolve(repoRoot, v.backedBy as string)))
      .map(([guard, v]) => `${guard} -> ${v.backedBy as string}`);
    expect(
      missing,
      `exemption(s) naming a backing test that no longer exists: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every backing test is actually COLLECTED by the suite CI runs', () => {
    // Existing on disk is not enough — a test under an excluded path never runs, so the
    // exemption would rest on a file CI silently skips. vitest.config.ts collects
    // `tests/**/*.test.ts` and excludes tests/browser/** and tests/browser-motion/**.
    const include = /^tests\/.+\.test\.tsx?$/;
    const excluded = [/^tests\/browser\//, /^tests\/browser-motion\//];
    const uncollected = Object.entries(CI_EXEMPT_PUSH_GATE_GUARDS)
      .filter(([, v]) => v.backedBy !== null)
      .filter(([, v]) => {
        const p = v.backedBy as string;
        return !include.test(p) || excluded.some((re) => re.test(p));
      })
      .map(([guard, v]) => `${guard} -> ${v.backedBy as string}`);
    expect(
      uncollected,
      `backing test(s) outside the collected glob, so CI never runs them: ${uncollected.join(', ')}`,
    ).toEqual([]);
  });

  it('every exemption states a reason', () => {
    const blank = Object.entries(CI_EXEMPT_PUSH_GATE_GUARDS)
      .filter(([, v]) => v.why.trim().length < 20)
      .map(([guard]) => guard);
    expect(blank, `exemption(s) without a substantive reason: ${blank.join(', ')}`).toEqual([]);
  });
});
