import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanGitEnv } from '../../src/lib/git-env.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  BRANCH_STEPS,
  CI_ONLY_GUARDS,
  CURATED_TEST_PATHS,
  FAST_PUSH_STEPS,
  NEUTRALIZED_SKIP_VARS,
  RELEASE_STEPS,
  runStep,
} from '../../scripts/push-gate.ts';

/**
 * Registry test for the declarative push-gate manifest (#2224).
 *
 * Behavior asserted (not implementation detail):
 *  1. No silent gate-drops: every `guard:*` script in package.json is either
 *     a step in a pipeline or explicitly listed as CI-only with a reason.
 *  2. No phantom references: every guard step in the manifest names a real
 *     package.json script.
 *  3. Line-length ratchet: the verify:* entry points never grow back into
 *     unreadable shell strings (≤120 chars each).
 *  4. Anti-drift: every curated test path exists on disk, and the manifest's
 *     own registry test is dogfooded into the curated list.
 *  5. Legacy-parity invariants: the neutralized skip-var list matches the
 *     legacy unset preamble; both lanes keep their distinctive terminal
 *     steps (scope print / console-browser).
 *
 * Accepted-risk note (coverage-honesty, LabRatQ challenge): a guard that is
 * renamed consistently in BOTH package.json and the manifest passes this
 * registry — rename coherence is reviewed by humans, not asserted here.
 * Hermeticity: source/disk reads and a local Vitest configuration probe;
 * no network or host service state.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

const allGuardScripts = Object.keys(pkg.scripts).filter((name) =>
  name.startsWith('guard:'),
);

const pipelineGuards = new Set(
  [...BRANCH_STEPS, ...RELEASE_STEPS]
    .map((step) => step.name)
    .filter((name) => name.startsWith('guard:')),
);

const ciOnlyNames = new Set(CI_ONLY_GUARDS.map((entry) => entry.name));
const gateTmp = trackTmpDirs('push-gate-outcomes-');

describe('push-gate child outcomes', () => {
  it.each([['SIGTERM', 143], ['SIGKILL', 137]] as const)('preserves and identifies %s', async (signal, exitCode) => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runStep({ name: 'signal-probe', cmd: `${process.execPath} -e process.kill(process.pid,'${signal}')` });
      expect(result).toBe(exitCode);
      expect(diagnostic.mock.calls).toHaveLength(1);
      expect(diagnostic.mock.calls[0]?.[0]).toMatch(new RegExp(`^push-gate: signal-probe terminated by ${signal} \\(pid \\d+\\); exit ${exitCode}$`));
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('reports an unavailable executable as inconclusive', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runStep({ name: 'unavailable-probe', cmd: '/whatsoup-nonexistent-test-executable' })).toBe(125);
      expect(diagnostic.mock.calls).toEqual([['push-gate: unavailable-probe could not start (ENOENT); exit 125']]);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('preserves a completed check failure', async () => {
    expect(await runStep({ name: 'failed-check', cmd: `${process.execPath} -e process.exit(7)` })).toBe(7);
  });

  it.each([
    ['exit 7', 7],
    ['exit 125', 125],
    ['kill -TERM "$$"', 143],
  ] as const)('propagates %s through the normal release entry point', (body, exitCode) => {
    const cwd = gateTmp.make('repo');
    execFileSync('git', ['init', '--quiet', cwd], { env: cleanGitEnv(), timeout: 5_000 });
    writeFileSync(join(cwd, 'npm'), `#!/bin/sh\necho fixture-step >&2\n${body}\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [resolve('scripts/push-gate.ts'), 'release'], {
      cwd,
      env: { ...cleanGitEnv(), PATH: `${cwd}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(exitCode);
    expect(result.stderr.match(/^fixture-step$/gm)).toHaveLength(1);
    expect(result.stderr).toContain(`FAIL at step 1/${RELEASE_STEPS.length}`);
    expect(result.stderr).toContain(`(exit ${exitCode})`);
    if (exitCode === 143) {
      expect(result.stderr).toMatch(/push-gate: guard:repo:release-hygiene terminated by SIGTERM \(pid \d+\); exit 143/);
    }
    expect(result.stdout).not.toContain('steps passed');
  });
});

describe('push-gate manifest registry (#2224)', () => {
  it('every package.json guard:* script is in a pipeline or explicitly CI-only', () => {
    const unregistered = allGuardScripts.filter(
      (name) => !pipelineGuards.has(name) && !ciOnlyNames.has(name),
    );
    expect(
      unregistered,
      `guard script(s) missing from both pipelines and CI_ONLY_GUARDS: ${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('every CI-only entry names a real guard script and carries a reason', () => {
    for (const entry of CI_ONLY_GUARDS) {
      expect(
        allGuardScripts,
        `${entry.name} listed CI-only but does not exist in package.json`,
      ).toContain(entry.name);
      expect(entry.reason.trim().length, `${entry.name} needs a reason`).toBeGreaterThan(0);
      expect(
        pipelineGuards.has(entry.name),
        `${entry.name} is both a pipeline step and CI-only — contradiction`,
      ).toBe(false);
    }
  });

  it('every manifest guard step names a real package.json script', () => {
    for (const name of pipelineGuards) {
      expect(
        allGuardScripts,
        `manifest references ${name} but package.json has no such script`,
      ).toContain(name);
    }
  });

  it('push/release pipeline entry points stay ≤120 chars (never grows back)', () => {
    // Scoped to the push-gate pipelines this issue owns. verify:console-design:live
    // (679 chars) is a separate console lane — a documented follow-up candidate,
    // not this issue's scope.
    const pipelineEntries = Object.keys(pkg.scripts).filter(
      (key) => key.startsWith('verify:push') || key.startsWith('verify:release'),
    );
    expect(pipelineEntries.length).toBeGreaterThan(0);
    for (const name of pipelineEntries) {
      expect(
        pkg.scripts[name].length,
        `${name} is ${pkg.scripts[name].length} chars — orchestration belongs in scripts/push-gate.ts, not in a shell string`,
      ).toBeLessThanOrEqual(120);
    }
  });

  it('entry points invoke the manifest runner for both lanes', () => {
    expect(pkg.scripts['verify:push:branch']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/push-gate.ts branch',
    );
    expect(pkg.scripts['verify:release']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/push-gate.ts release',
    );
  });

  it('the fast push tier keeps the disclosure checks and builds nothing', () => {
    expect(pkg.scripts['verify:push:fast']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/push-gate.ts fast',
    );
    expect(FAST_PUSH_STEPS.map((step) => step.name)).toEqual([
      'guard:repo:branch-diff',
      'guard:repo:commit-authors',
      'guard:publication:all',
      'guard:publication:branch-diff',
      'push-gate-scope',
    ]);
    for (const step of FAST_PUSH_STEPS) {
      expect(step.cmd, `${step.name} must not build or run a suite`).not.toMatch(/npm test|typecheck|--prefix console|vitest|pytest/);
      if (step.name.startsWith('guard:')) expect(allGuardScripts).toContain(step.name);
    }
    expect(FAST_PUSH_STEPS[FAST_PUSH_STEPS.length - 1].cmd).toBe('bash scripts/print-push-gate-scope.sh fast');
  });

  it('the heavy checks the fast tier omits stay in the complete gate', () => {
    const branchNames = BRANCH_STEPS.map((step) => step.name);
    for (const name of ['typecheck:all', 'curated-tests', 'verify:console-design', 'console-build', 'test:deployment-qualification']) {
      expect(branchNames).toContain(name);
    }
  });

  it('keeps deployment qualification in both local lanes and the Quality workflow', () => {
    const expectedCommand = 'npm run test:deployment-qualification';
    for (const steps of [BRANCH_STEPS, RELEASE_STEPS]) {
      expect(steps).toContainEqual(
        expect.objectContaining({ name: 'test:deployment-qualification', cmd: expectedCommand }),
      );
    }

    const qualityWorkflow = readFileSync('.github/workflows/quality.yml', 'utf8');
    expect(qualityWorkflow).toContain(
      '      - name: Deployment qualification source suite\n        run: npm run test:deployment-qualification',
    );

    const command = pkg.scripts['test:deployment-qualification'];
    expect(command).toContain('bash -euc');
    expect(command).not.toContain('bash -lc');
    expect(command).toContain('deploy/scripts/lib/pytest-runner.sh');
  });

  it('every curated test path exists on disk', () => {
    const missing = CURATED_TEST_PATHS.filter((path) => !existsSync(path));
    expect(missing, `curated test path(s) drifted from disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('the curated list dogfoods this registry test', () => {
    expect([...CURATED_TEST_PATHS]).toContain('tests/scripts/push-gate-manifest.test.ts');
  });

  it('curated list has no duplicates and no flags masquerading as paths', () => {
    expect(new Set(CURATED_TEST_PATHS).size).toBe(CURATED_TEST_PATHS.length);
    for (const path of CURATED_TEST_PATHS) {
      expect(path.startsWith('--'), `${path} looks like a flag, not a path`).toBe(false);
      expect(path.endsWith('.test.ts'), `${path} is not a test file`).toBe(true);
    }
  });

  it('neutralized skip-vars match the legacy unset preamble', () => {
    expect([...NEUTRALIZED_SKIP_VARS]).toEqual([
      'WHATSOUP_SKIP_DOC_DRIFT',
      'WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT',
      'WHATSOUP_SKIP_NODE_PIN_CHECK',
      'WHATSOUP_SKIP_BOUNDARY_CHECK',
      'WHATSOUP_SKIP_ESLINT_FITNESS',
    ]);
  });

  it('both lanes keep their distinctive terminal steps and mid-block semantic:shadow position', () => {
    expect(BRANCH_STEPS[BRANCH_STEPS.length - 1].cmd).toBe('bash scripts/print-push-gate-scope.sh');
    expect(RELEASE_STEPS[RELEASE_STEPS.length - 1].name).toBe('verify:console-browser');
    // Legacy parity: semantic:shadow runs mid-guard-block, not at the end.
    const branchShadowIndex = BRANCH_STEPS.findIndex((step) => step.name === 'verify:semantic:shadow');
    expect(branchShadowIndex).toBeGreaterThan(0);
    expect(BRANCH_STEPS[branchShadowIndex - 1].name).toBe('guard:safeguard-diagnostics');
    expect(BRANCH_STEPS[branchShadowIndex + 1].name).toBe('guard:test-integrity');
    const releaseShadowIndex = RELEASE_STEPS.findIndex((step) => step.name === 'verify:semantic:shadow');
    expect(RELEASE_STEPS[releaseShadowIndex - 1].name).toBe('guard:safeguard-diagnostics');
    expect(RELEASE_STEPS[releaseShadowIndex + 1].name).toBe('guard:test-integrity:required');
  });

  it('promotes guard-test coverage semantic proof explicitly in both blocking lanes', () => {
    for (const steps of [BRANCH_STEPS, RELEASE_STEPS]) {
      expect(steps.find(({ name }) => name === 'guard:guard-test-coverage')?.cmd).toBe(
        'npm run guard:guard-test-coverage -- --semantic-mode enforce',
      );
    }
  });

  it('step names are unique within each lane (attribution is unambiguous)', () => {
    for (const steps of [BRANCH_STEPS, RELEASE_STEPS]) {
      const names = steps.map((step) => step.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('every step command is shell-free tokenizable (the runner uses no shell)', () => {
    // The runner spawns with shell:false (repo-hygiene: child-process-shell-true).
    // A cmd containing shell metacharacters would silently change semantics
    // when tokenized — so it must fail review here instead.
    const shellMetachar = /["';|&$`<>()\\{}[\]\n]/;
    for (const step of [...BRANCH_STEPS, ...RELEASE_STEPS, ...FAST_PUSH_STEPS]) {
      expect(
        shellMetachar.test(step.cmd),
        `${step.name}: '${step.cmd}' needs a shell — rewrite as plain argv tokens`,
      ).toBe(false);
      expect(step.cmd.trim().length, `${step.name} has an empty cmd`).toBeGreaterThan(0);
    }
  });

  it('the child env allowlist excludes the neutralized skip-vars and passes WHATSOUP_* through', async () => {
    const { pushGateChildEnv } = await import('../../scripts/push-gate.ts');
    process.env.WHATSOUP_SKIP_DOC_DRIFT = '1';
    process.env.WHATSOUP_SKIP_ESLINT_FITNESS = '1';
    process.env.WHATSOUP_TEST_PASSTHROUGH_PROBE = 'probe';
    try {
      const env = pushGateChildEnv();
      expect(env.WHATSOUP_SKIP_DOC_DRIFT).toBeUndefined();
      expect(env.WHATSOUP_SKIP_ESLINT_FITNESS).toBeUndefined();
      expect(env.WHATSOUP_TEST_PASSTHROUGH_PROBE).toBe('probe');
      expect(typeof env.PATH).toBe('string');
      delete process.env.WHATSOUP_SKIP_DOC_DRIFT;
      delete process.env.WHATSOUP_SKIP_ESLINT_FITNESS;
      delete process.env.WHATSOUP_TEST_PASSTHROUGH_PROBE;
    } finally {
      delete process.env.WHATSOUP_SKIP_DOC_DRIFT;
      delete process.env.WHATSOUP_SKIP_ESLINT_FITNESS;
      delete process.env.WHATSOUP_TEST_PASSTHROUGH_PROBE;
    }
  });

  it('passes the live push base through to the branch-diff steps', async () => {
    const { pushGateChildEnv } = await import('../../scripts/push-gate.ts');
    const { PUSH_BASE_OID_ENV } = await import('../../scripts/lib/guard-core.ts');
    const priorValue = process.env[PUSH_BASE_OID_ENV];
    process.env[PUSH_BASE_OID_ENV] = 'b'.repeat(40);
    try {
      expect(pushGateChildEnv()[PUSH_BASE_OID_ENV]).toBe('b'.repeat(40));
    } finally {
      if (priorValue === undefined) delete process.env[PUSH_BASE_OID_ENV];
      else process.env[PUSH_BASE_OID_ENV] = priorValue;
    }
  });

  it('every env var a gate step reads survives the child allowlist', async () => {
    const { pushGateChildEnv } = await import('../../scripts/push-gate.ts');
    const source = readFileSync('scripts/full-suite-battery.ts', 'utf8');
    const envNames = [...source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);

    expect(envNames.length, 'no process.env reads found — scan is vacuous').toBeGreaterThan(0);

    for (const envName of envNames) {
      const wasPresent = Object.prototype.hasOwnProperty.call(process.env, envName);
      const priorValue = process.env[envName];
      process.env[envName] = 'reachability-probe';
      try {
        expect(
          pushGateChildEnv()[envName],
          `scripts/full-suite-battery.ts reads ${envName}, but pushGateChildEnv() strips it`,
        ).toBe('reachability-probe');
      } finally {
        if (wasPresent) process.env[envName] = priorValue;
        else delete process.env[envName];
      }
    }
  });

  it.each([undefined, '1', '2', '3', '4'])('applies worker count %s after the gate child environment boundary', async (requested) => {
    const { pushGateChildEnv } = await import('../../scripts/push-gate.ts');
    const prior = process.env.VITEST_MAX_WORKERS;
    if (requested === undefined) delete process.env.VITEST_MAX_WORKERS;
    else process.env.VITEST_MAX_WORKERS = requested;
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createVitest } from 'vitest/node';
        const vitest = await createVitest('test', { watch: false, run: true, pool: 'forks' });
        try {
          console.log(JSON.stringify({
            maxWorkers: vitest.config.maxWorkers,
            testTimeout: vitest.config.testTimeout,
            pool: vitest.config.pool,
          }));
        } finally {
          await vitest.close();
        }
      `], { env: pushGateChildEnv(), encoding: 'utf8', timeout: 8_000 });
      expect(JSON.parse(output)).toEqual({ maxWorkers: requested === undefined ? 4 : Number(requested), testTimeout: 10_000, pool: 'forks' });
    } finally {
      if (prior === undefined) delete process.env.VITEST_MAX_WORKERS;
      else process.env.VITEST_MAX_WORKERS = prior;
    }
  });

  it.each(['8', '0', '-1', '1.5', '2x', '', ' 2', '02', '50%', 'NaN', 'Infinity'])('rejects invalid or increased worker count %s before launching a gate child', async (requested) => {
    const { pushGateChildEnv } = await import('../../scripts/push-gate.ts');
    const prior = process.env.VITEST_MAX_WORKERS;
    process.env.VITEST_MAX_WORKERS = requested;
    try {
      expect(() => pushGateChildEnv()).toThrow('VITEST_MAX_WORKERS must be an integer from 1 through 4');
    } finally {
      if (prior === undefined) delete process.env.VITEST_MAX_WORKERS;
      else process.env.VITEST_MAX_WORKERS = prior;
    }
  });
});
