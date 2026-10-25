import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';
import { fitnessRules } from '../../scripts/lib/fitness/registry.ts';
// @ts-expect-error -- flat config is a .mjs module with no type declarations; expires 2026-12-31
import fitnessConfigRaw, { eslintRingRuleIds as eslintRingRuleIdsRaw, enabledFitnessRuleNames as enabledFitnessRuleNamesRaw, eslintRingRuleNames as eslintRingRuleNamesRaw } from '../../eslint.config.fitness.mjs';

const eslintRingRuleIds = eslintRingRuleIdsRaw as string[];
const enabledFitnessRuleNames = enabledFitnessRuleNamesRaw as string[];
const eslintRingRuleNames = eslintRingRuleNamesRaw as string[];
const fitnessConfig = fitnessConfigRaw as Array<{
  files?: string[];
  rules?: Record<string, unknown>;
}>;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('eslint fitness config — registry drift', () => {
  it('enforces exactly the registry rules whose rings include eslint', () => {
    const expected = fitnessRules
      .filter((rule) => (rule.rings as readonly string[]).includes('eslint'))
      .map((rule) => rule.id)
      .sort();

    // If a rule gains/loses the eslint ring in the registry, this fails until the
    // config is updated — the registry stays the single source of truth.
    expect(eslintRingRuleIds).toEqual(expected);
  });

  it('actually ENABLES every eslint-ring rule in a files block (not just lists its id)', () => {
    // Regression guard: an eslint-ring rule mapped in ruleEntriesFor but never spread
    // into a `files` block silently never runs (the timer-rearm-without-clear gap). The
    // id-list assertion above passed over that dead rule; this checks real enablement.
    const enabled = new Set(enabledFitnessRuleNames);
    const missing = eslintRingRuleNames.filter((name) => !enabled.has(name));
    expect(missing).toEqual([]);
  });

  it('covers the fifteen known eslint-ring rules', () => {
    expect(eslintRingRuleIds).toEqual([
      'arch.approved-api-client',
      'arch.env-read-justification',
      'arch.file-size',
      'arch.god-class',
      'arch.ring-boundaries',
      'arch.sqlite-busy-timeout-ssot',
      'hygiene.catch-justification',
      'invariant.fail-closed-scanner',
      'invariant.no-unsafe-type-escapes',
      'invariant.outbox-env-gated',
      'invariant.timer-rearm-without-clear',
      'portability.fetch-timeout',
      'portability.hardcoded-signal-name',
      'portability.sync-exec-timeout',
      'test.skip-categorization',
    ]);
  });

  it('scopes catch-ratchet enforcement to the src tree its baseline scans', () => {
    const catchBlocks = fitnessConfig.filter(
      (block) => block.rules?.['fitness/require-catch-justification'] !== undefined,
    );
    expect(catchBlocks).toHaveLength(1);
    expect(catchBlocks[0]?.files).toEqual(['src/**/*.ts']);
  });

  it('scopes env-read justification to the src tree its allowlist scans', () => {
    // The vitest authority (env-read-allowlist.test.ts) scans src/ exactly;
    // the eslint mirror must not widen or narrow that scope (#2192 slice 5a).
    const envBlocks = fitnessConfig.filter(
      (block) => block.rules?.['fitness/require-env-justification'] !== undefined,
    );
    expect(envBlocks).toHaveLength(1);
    expect(envBlocks[0]?.files).toEqual(['src/**/*.ts']);
  });
});

describe('eslint fitness wrapper — full repository scan', () => {
  let result: Awaited<ReturnType<typeof runEslintFitness>>;

  beforeAll(async () => {
    // Both assertions need the same real repository scan. Keep it in this
    // suite so Vitest's isolated file workers do not repeat the expensive pass.
    result = await runEslintFitness(repoRoot);
    // Coverage instrumentation and CPU contention make this scan much slower
    // in CI. Preserve the existing 420s scan budget without loosening failures.
  }, 420_000);

  it('treats warning-only results as non-blocking and reports errors as blocking', () => {

    // The repo currently has known fitness warnings (AgentRuntime god-class,
    // oversized files, uncategorized skips, fail-open catches) and NO configured
    // errors. The wrapper must see warnings but zero errors / no fatal parse.
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.errorCount).toBe(0);
    expect(result.fatal).toBe(false);

    // The flagship dark-ring rule must be live: AgentRuntime is reported.
    const godClass = result.issues.find(
      (i) => i.code === 'fitness/god-class' && i.filePath?.endsWith('runtime.ts'),
    );
    expect(godClass).toBeDefined();

    // Non-vacuity: the real ring lints hundreds of files, so a pass is not a pass-over-nothing.
    expect(result.filesLinted).toBeGreaterThan(100);
  });

  it('no sync exec call in the linted tree lacks a timeout (spread-carried sites pinned)', () => {
    // The fitness ring is warn-only, so this assertion enforces zero new bare
    // execSync / execFileSync / spawnSync calls. Fix new offenders by adding
    // timeout options; do not grow the grandfather set.
    // These four rule false positives spread keyringExecOptions, which carries
    // KEYRING_COMMAND_TIMEOUT_MS. Re-verify that timeout before moving a pin.
    const spreadCarriedTimeoutSites = [
      'src/lib/keyring.ts:514',
      'src/lib/keyring.ts:542',
      'src/lib/keyring.ts:802',
      'src/lib/keyring.ts:843',
    ];
    expect(result.filesLinted).toBeGreaterThan(0);
    const offenders = result.issues
      .filter((issue) => issue.code === 'fitness/sync-exec-timeout')
      .map((issue) => `${issue.filePath}:${issue.line}`)
      .sort();

    expect(offenders, `Sync exec timeout findings:\n${offenders.join('\n')}`)
      .toEqual(spreadCarriedTimeoutSites);
  });
});

describe('eslint fitness wrapper — refuses a scan of zero files', () => {
  const temps: string[] = [];
  afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('is INCONCLUSIVE (exit 2), never a pass, when the fitness globs match no files', async () => {
    // `errorOnUnmatchedPattern: false` means a valid config with zero matching files yields a
    // clean pass unless refused — the fail-open shape. A throwaway root with a trivial-but-valid
    // flat config and no src/scripts/tests reaches exactly that state (a wrong root instead
    // fail-closes at config load, exit 1 — this pins the subtler zero-files case).
    const { run, runEslintFitness } = await import('../../scripts/eslint-fitness-check.ts');
    const dir = mkdtempSync(join(tmpdir(), 'eslint-fitness-empty-'));
    temps.push(dir);
    writeFileSync(join(dir, 'eslint.config.fitness.mjs'), 'export default [];\n');

    const scan = await runEslintFitness(dir);
    expect(scan.filesLinted).toBe(0);

    const savedExit = process.exitCode;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      await run([], dir, {} as NodeJS.ProcessEnv);
      expect(process.exitCode, 'a zero-file lint must not pass').toBe(2);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/i);
      expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/passed/i);
    } finally {
      process.exitCode = savedExit;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 60_000);
});

describe('eslint fitness rule — sync exec option overloads', () => {
  it.each([
    { call: "execFileSync('node', ['--version'])", severities: [1] },
    { call: "execFileSync('node', ['--version'], {})", severities: [1] },
    { call: "execFileSync('node', ['--version'], { timeout: 1000 })", severities: [] },
    { call: "execFileSync('node', { timeout: 1000 })", severities: [] },
    { call: "execFileSync('node', ['--version'] as string[])", severities: [1] },
    { call: "execFileSync('node', <string[]>['--version'])", severities: [1] },
    { call: "execFileSync('node', ['--version']!)", severities: [1] },
    { call: "execFileSync('node', ['--version'] satisfies string[])", severities: [1] },
    { call: "execFileSync('node', (['--version'] as string[])!)", severities: [1] },
    { call: "execFileSync('node', {} as object)", severities: [1] },
    { call: "execFileSync('node', ['--version'], {} satisfies object)", severities: [1] },
    { call: "execSync('node --version', <object>{})", severities: [1] },
    { call: "spawnSync('node', ['--version'], {}!)", severities: [1] },
    { call: "execFileSync('node', { timeout: 1000 } as object)", severities: [] },
    { call: "execFileSync('node', ['--version'] as string[], { timeout: 1000 })", severities: [] },
    { call: "execSync('node --version', <object>{ timeout: 1000 })", severities: [] },
    { call: "spawnSync('node', ['--version'], { timeout: 1000 } satisfies object)", severities: [] },
  ])('enforces timeout options for $call', async ({ call, severities }) => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: join(repoRoot, 'eslint.config.fitness.mjs'),
    });
    const results = await eslint.lintText(
      `import { execFileSync, execSync, spawnSync } from 'node:child_process';\n${call};\n`,
      { filePath: join(repoRoot, 'scripts', '__virtual_sync_exec.ts') },
    );

    expect(results).toHaveLength(1);
    expect(results[0].fatalErrorCount).toBe(0);
    expect(results[0].messages
      .filter((message) => message.ruleId === 'fitness/sync-exec-timeout')
      .map((message) => message.severity)).toEqual(severities);
  });
});

describe('eslint fitness rule — db-read-prefix', () => {
  // --stdin --stdin-filename matches the fitness config's src/** glob without
  // writing scratch files into the real src/ tree (warn-level rules exit 0,
  // so stdout capture needs no try/catch).
  const lintVirtualSrcFile = (source: string): string =>
    execFileSync(
      'npx',
      [
        'eslint',
        '--config', join(repoRoot, 'eslint.config.fitness.mjs'),
        '--stdin',
        '--stdin-filename', join(repoRoot, 'src', '_virtual_db_read_prefix.ts'),
      ],
      { encoding: 'utf8', stdio: 'pipe', input: source, cwd: repoRoot },
    );

  it('flags export function load* with db: Database param', () => {
    const stdout = lintVirtualSrcFile(
      'export function loadUsers(db: Database): string[] { return []; }\n',
    );
    expect(stdout).toContain('fitness/db-read-prefix');
  }, 60_000);

  it('passes clean get-prefixed code', () => {
    const stdout = lintVirtualSrcFile(
      'export function getUsers(db: Database): string[] { return []; }\n',
    );
    expect(stdout).not.toContain('fitness/db-read-prefix');
  }, 60_000);
});
