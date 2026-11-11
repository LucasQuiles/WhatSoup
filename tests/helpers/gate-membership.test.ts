/**
 * The helper two protection suites depend on, tested against synthetic inputs.
 *
 * Both callers assert "no unreachable checks", so on a healthy repo they only ever exercise
 * the reachable branches — the NEGATIVE path is what actually protects them, and on a green
 * tree it never runs. These tests drive it directly with fixture inputs so a regression in
 * `scriptReachability` cannot quietly turn both suites into unconditional passes.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import ts from 'typescript';
import { BRANCH_STEPS } from '../../scripts/push-gate.ts';

import {
  CI_EXEMPT_PUSH_GATE_GUARDS,
  backstopReachability,
  namedInCi,
  pushGateGuards,
  readGateInputs,
  runsFullSuite,
  scriptReachability,
  type GateInputs,
} from './gate-membership.ts';

const inputs = (overrides: Partial<GateInputs> = {}): GateInputs => ({
  scripts: {
    'verify:push:branch': 'npm run guard:alpha && npm run guard:ssot-patterns && npm test',
    'guard:alpha': 'echo alpha',
    'guard:ssot-patterns': 'echo ssot',
  },
  // Models Quality's direct non-PR full profile. Tags now start Quality directly;
  // the trusted receipt consumer only releases after that exact completed run.
  qualityWorkflow:
    "on:\n  push:\n    branches: [main]\n    tags: ['v*']\n" +
    'jobs:\n  selection:\n    outputs:\n      profile: ${{ steps.plan.outputs.profile }}\n    steps:\n      - id: plan\n        run: |\n          const isPr = process.env.GITHUB_EVENT_NAME === \'pull_request\';\n          const plan = !isPr || controlsChanged ? { profile: \'full\' } : candidatePlan;\n' +
    '  full:\n    needs: selection\n    if: needs.selection.outputs.profile == \'full\'\n    steps:\n      - name: Alpha\n        run: npm run guard:alpha\n      - name: Tests\n        run: npm run coverage:check\n',
  // Models the trusted completion consumer; it cannot execute a tag candidate.
  tagReleaseWorkflow:
    'on:\n  workflow_run:\n    workflows: [Quality]\n    types: [completed]\n' +
    "jobs:\n  release-gate:\n    if: >-\n      github.event.workflow_run.event == 'push' &&\n      startsWith(github.event.workflow_run.head_branch, 'v')\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          ref: ${{ github.sha }}\n      - run: node scripts/private-integrity-release.ts select\n      - run: node scripts/private-integrity-release.ts verify --receipt \"$RUNNER_TEMP/private-integrity/receipt.json\"\n",
  ...overrides,
});

describe('pushGateGuards', () => {
  it('extracts, dedupes and sorts the guard scripts the push gate invokes', () => {
    expect(pushGateGuards(inputs().scripts)).toEqual(['guard:alpha', 'guard:ssot-patterns']);
  });

  it('returns empty when verify:push:branch is absent rather than throwing', () => {
    expect(pushGateGuards({})).toEqual([]);
  });

  it('does not pick up non-guard npm scripts from the chain', () => {
    expect(pushGateGuards(inputs().scripts)).not.toContain('npm');
  });
});

describe('namedInCi', () => {
  it('matches a guard that has a named step', () => {
    expect(namedInCi('guard:alpha', inputs().qualityWorkflow)).toBe(true);
  });

  it('does not match a guard that has none', () => {
    expect(namedInCi('guard:ssot-patterns', inputs().qualityWorkflow)).toBe(false);
  });

  it('does NOT let a longer-named sibling satisfy a shorter guard', () => {
    // The regression the negative lookahead exists for: `npm run guard:repo:commit-authors`
    // in the workflow must not make bare `guard:repo` report as covered, or a guard absent
    // from CI reads as present because a different guard happens to run.
    const wf = '        run: npm run guard:repo:commit-authors\n';
    expect(namedInCi('guard:repo:commit-authors', wf)).toBe(true);
    expect(namedInCi('guard:repo', wf)).toBe(false);
  });
});

describe('scriptReachability', () => {
  it('credits the trusted scanner only while its separate workflow remains connected', () => {
    const gate = readGateInputs(fileURLToPath(new URL('../..', import.meta.url)));
    for (const path of ['pull-request', 'tag-release'] as const) {
      expect(scriptReachability('guard:test-integrity', gate, path).reachable).toBe(true);
      expect(scriptReachability('guard:test-integrity', { ...gate, privateIntegrityWorkflow: '' }, path).reachable).toBe(false);
      expect(scriptReachability('guard:test-integrity', {
        ...gate, privateIntegrityWorkflow: gate.privateIntegrityWorkflow!.replace('types: [completed]', 'types: [requested]'),
      }, path).reachable).toBe(false);
    }
  });

  it('reports ci-step for a guard named in the workflow', () => {
    const r = scriptReachability('guard:alpha', inputs());
    expect(r).toMatchObject({ reachable: true, via: 'ci-step' });
  });

  it('reports push-gate-exemption for an exempted guard the push gate runs', () => {
    const r = scriptReachability('guard:ssot-patterns', inputs());
    expect(r).toMatchObject({ reachable: true, via: 'push-gate-exemption' });
    expect(r.detail).toContain('tests/scripts/ssot-pattern-guard.test.ts');
  });

  it('reports UNREACHABLE for a push-gate guard with no CI step and no exemption', () => {
    // The branch that carries the whole protection. A guard here runs only from the
    // advisory husky hook, so any server-side merge bypasses it.
    const gate = inputs({
      scripts: {
        'verify:push:branch': 'npm run guard:lonely',
        'guard:lonely': 'echo lonely',
      },
    });
    const r = scriptReachability('guard:lonely', gate);
    expect(r.reachable).toBe(false);
    expect(r.via).toBe('none');
    // The message must NAME the path it is talking about — an unreachability report that
    // does not say which gate is the ambiguity this helper was made path-aware to remove.
    expect(r.detail).toMatch(/pull-request/);
    expect(r.detail).toMatch(/does not run it/);
  });

  it('does NOT grant an exemption to a guard the push gate does not actually run', () => {
    // An exemption is a claim about a guard in the gate. If the guard left the gate, the
    // entry is stale and must not keep conferring reachability.
    const gate = inputs({ scripts: { 'verify:push:branch': 'npm run guard:alpha' } });
    expect(scriptReachability('guard:ssot-patterns', gate).reachable).toBe(false);
  });

  it('reports UNREACHABLE for a script that appears nowhere at all', () => {
    expect(scriptReachability('guard:does-not-exist', inputs()).reachable).toBe(false);
  });
});

describe('per-path reachability', () => {
  it('follows the direct tag Quality run and trusted completion consumer rather than hardcoding either path', () => {
    expect(runsFullSuite('pull-request', inputs())).toBe(true);
    expect(runsFullSuite('tag-release', inputs())).toBe(true);
  });

  it('an exempted push-gate guard is reachable on both full-suite paths', () => {
    expect(scriptReachability('guard:ssot-patterns', inputs(), 'pull-request').reachable).toBe(true);
    const tag = scriptReachability('guard:ssot-patterns', inputs(), 'tag-release');
    expect(tag.reachable).toBe(true);
  });

  it('a guard in the canonical full job is reachable on both paths', () => {
    expect(scriptReachability('guard:alpha', inputs(), 'pull-request').reachable).toBe(true);
    expect(scriptReachability('guard:alpha', inputs(), 'tag-release').reachable).toBe(true);
  });

  it('defaults to the pull-request path when none is given', () => {
    expect(scriptReachability('guard:ssot-patterns', inputs())).toEqual(
      scriptReachability('guard:ssot-patterns', inputs(), 'pull-request'),
    );
  });

  it('a test-file backstop tracks the callable full job on each path', () => {
    const entry = 'tests/scripts/anything.test.ts';
    expect(backstopReachability(entry, inputs(), 'pull-request').reachable).toBe(true);
    const tag = backstopReachability(entry, inputs(), 'tag-release');
    expect(tag.reachable).toBe(true);
  });

  it('does not borrow Quality coverage when the trusted completion consumer is misdirected', () => {
    const broken = inputs({
      tagReleaseWorkflow: inputs().tagReleaseWorkflow.replace(
        'workflows: [Quality]',
        'workflows: [Other workflow]',
      ),
    });
    expect(runsFullSuite('tag-release', broken)).toBe(false);
    expect(scriptReachability('guard:alpha', broken, 'tag-release').reachable).toBe(false);
  });

  it('does not credit a tag consumer that skips failed Quality runs', () => {
    const broken = inputs({
      tagReleaseWorkflow: inputs().tagReleaseWorkflow.replace(
        "      startsWith(github.event.workflow_run.head_branch, 'v')",
        "      github.event.workflow_run.conclusion == 'success' &&\n      startsWith(github.event.workflow_run.head_branch, 'v')",
      ),
    });
    expect(runsFullSuite('tag-release', broken)).toBe(false);
  });

  it('does not borrow Quality coverage when direct v-tag Quality dispatch is removed', () => {
    const broken = inputs({
      qualityWorkflow: inputs().qualityWorkflow.replace("    tags: ['v*']\n", ''),
    });
    expect(runsFullSuite('tag-release', broken)).toBe(false);
    expect(backstopReachability('tests/scripts/anything.test.ts', broken, 'tag-release').reachable).toBe(false);
  });

  it('does not credit an unselected Quality full job to the tag caller', () => {
    const broken = inputs({
      qualityWorkflow: inputs().qualityWorkflow.replace(
        "if: needs.selection.outputs.profile == 'full'",
        'if: false',
      ),
    });
    expect(runsFullSuite('tag-release', broken)).toBe(false);
    expect(backstopReachability('tests/scripts/anything.test.ts', broken, 'tag-release').reachable).toBe(false);
  });

  it.each([
    ["const isPr = process.env.GITHUB_EVENT_NAME === 'pull_request'", 'const isPr = true'],
    ['!isPr || controlsChanged', 'isPr || controlsChanged'],
    ["profile: 'full'", "profile: 'docs'"],
    ['id: plan', 'id: disconnected'],
    ['${{ steps.plan.outputs.profile }}', '${{ steps.other.outputs.profile }}'],
  ])('rejects broken non-PR selection wiring: %s', (before, after) => {
    const broken = inputs({ qualityWorkflow: inputs().qualityWorkflow.replace(before, after) });
    expect(runsFullSuite('tag-release', broken)).toBe(false);
    expect(scriptReachability('guard:alpha', broken, 'tag-release').reachable).toBe(false);
  });

  it('backstopReachability routes npm scripts to scriptReachability unchanged', () => {
    for (const path of ['pull-request', 'tag-release'] as const) {
      expect(backstopReachability('guard:ssot-patterns', inputs(), path)).toEqual(
        scriptReachability('guard:ssot-patterns', inputs(), path),
      );
    }
  });
});

describe('CI_EXEMPT_PUSH_GATE_GUARDS', () => {
  it('every entry states a reason, and backedBy is a path or an explicit null', () => {
    for (const [guard, entry] of Object.entries(CI_EXEMPT_PUSH_GATE_GUARDS)) {
      expect(entry.why.length, `${guard} needs a substantive reason`).toBeGreaterThan(30);
      if (entry.backedBy !== null) {
        expect(entry.backedBy, `${guard} backedBy must be a repo-relative test path`).toMatch(
          /^tests\/.*\.test\.ts$/,
        );
      }
    }
  });
});
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const liveGate = readGateInputs(repoRoot);
const packageJson = { scripts: liveGate.scripts };
const qualityWorkflow = liveGate.qualityWorkflow;
const whatsoupGuardWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/whatsoup-guard.yml'), 'utf8');
const branchChain = BRANCH_STEPS.map((step) => step.cmd).join(' && ');

describe('quality workflow composition', () => {
  it('keeps the planner dependency-free with its shared imports covered by the workflow controls', () => {
    const visited = new Set<string>();
    const inspect = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const imported of ts.preProcessFile(readFileSync(file, 'utf8')).importedFiles) {
        if (imported.fileName.startsWith('node:')) continue;
        expect(imported.fileName, `planner dependency in ${file}`).toMatch(/^\./);
        inspect(resolve(dirname(file), imported.fileName));
      }
    };
    inspect(resolve(repoRoot, 'scripts/test-plan.ts'));
    expect([...visited].filter((file) => !file.startsWith(`${repoRoot}/scripts/`)).sort()).toEqual([
      resolve(repoRoot, 'src/lib/git-env.ts'),
      resolve(repoRoot, 'src/lib/type-guards.ts'),
    ]);
  });

  it.each([
    ['scripts/test-plan.ts', 'pull_request', 'full', false],
    ['scripts/lib/test-selection-policy.ts', 'pull_request', 'full', false],
    ['src/lib/type-guards.ts', 'pull_request', 'full', false],
    ['src/lib/git-env.ts', 'pull_request', 'full', false],
    ['.github/workflows/quality.yml', 'pull_request', 'full', false],
    ['deploy/bot-errors-runtime-manifest.json', 'pull_request', 'full', false],
    ['package.json', 'pull_request', 'full', false],
    ['package-lock.json', 'pull_request', 'full', false],
    ['.nvmrc', 'pull_request', 'full', false],
    ['.npmrc', 'pull_request', 'full', false],
    ['README.md', 'pull_request', 'docs', true],
    ['README.md', 'push', 'full', false],
  ] as const)('binds selection to changed controls and event: %s %s', (changedPath, event, profile, plannerRuns) => {
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-selection-authority-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      mkdirSync(resolve(root, 'scripts'), { recursive: true });
      const planner = resolve(root, 'scripts/test-plan.ts');
      writeFileSync(planner, `import { writeFileSync } from 'node:fs';
writeFileSync('planner-ran', 'yes');
console.log(JSON.stringify({ profile: 'docs', reasons: [], changedFiles: ['README.md'], lanes: Object.fromEntries(['root', 'console', 'browser', 'python', 'guard', 'docker', 'compatibility'].map(x => [x, false])) }));
`);
      git('add', '.');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
      const base = git('rev-parse', 'HEAD').trim();
      mkdirSync(dirname(resolve(root, changedPath)), { recursive: true });
      writeFileSync(resolve(root, changedPath), changedPath === 'scripts/test-plan.ts' ? `${readFileSync(planner, 'utf8')}\n` : 'changed\n');
      git('add', '.');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'candidate');
      const workflow = parseYaml(qualityWorkflow);
      const step = workflow.jobs.selection.steps.find((entry: { id?: string }) => entry.id === 'plan');
      const output = resolve(root, 'output');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: root, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, GITHUB_EVENT_NAME: event, TEST_BASE: base, GITHUB_OUTPUT: output, RUNNER_TEMP: root },
      });
      expect(result.status, result.stderr).toBe(0);
      const planLine = readFileSync(output, 'utf8').split('\n').find((line) => line.startsWith('plan='));
      const plan = JSON.parse(planLine!.slice('plan='.length));
      expect(plan.profile).toBe(profile);
      expect(plan.lanes).toEqual(profile === 'full'
        ? { root: true, console: true, browser: true, python: true, guard: true, docker: true, compatibility: true }
        : { root: false, console: false, browser: false, python: false, guard: false, docker: false, compatibility: false });
      expect(existsSync(resolve(root, 'planner-ran'))).toBe(plannerRuns);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps disclosure and public-surface guards ahead of every reduced PR profile without installing dependencies', () => {
    const selection = qualityWorkflow.slice(qualityWorkflow.indexOf('  selection:'), qualityWorkflow.indexOf('  docs:'));
    expect(selection).toContain("if: github.event_name == 'pull_request' && steps.plan.outputs.profile != 'full'");
    expect(selection).toContain('node --experimental-strip-types scripts/repo-hygiene-guard.ts --branch-diff --base "$TEST_BASE"');
    expect(selection).toContain('node --experimental-strip-types scripts/repo-hygiene-guard.ts --commit-authors');
    expect(selection).toContain('node --experimental-strip-types scripts/publication-guard.ts --all');
    expect(selection).toContain('node --experimental-strip-types scripts/publication-guard.ts --branch-diff');
    expect(selection).toContain('node --experimental-strip-types scripts/public-surface-drift-check.ts');
    expect(selection).not.toContain('npm ci');
  });

  it('propagates a public-surface guard failure through the normal reduced-profile step', () => {
    const workflow = parseYaml(qualityWorkflow);
    const step = workflow.jobs.selection.steps.find((entry: { name?: string }) => entry.name?.startsWith('Disclosure guards'));
    const root = mkdtempSync(resolve(tmpdir(), 'whatsoup-docs-guard-'));
    try {
      mkdirSync(resolve(root, 'scripts'));
      writeFileSync(resolve(root, 'scripts/repo-hygiene-guard.ts'), 'process.exit(0);\n');
      writeFileSync(resolve(root, 'scripts/publication-guard.ts'), 'process.exit(0);\n');
      writeFileSync(resolve(root, 'scripts/public-surface-drift-check.ts'), 'process.exit(23);\n');
      const execute = () => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TEST_BASE: 'fixture-base' },
      });
      expect(execute().status).toBe(23);
      writeFileSync(resolve(root, 'scripts/public-surface-drift-check.ts'), 'process.exit(0);\n');
      expect(execute().status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the metadata guard in the public command and local branch gate', () => {
    expect(packageJson.scripts['guard:pr-metadata']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/pr-metadata-guard.ts',
    );
    expect(branchChain).toContain(
      'tests/scripts/pr-metadata-guard.test.ts',
    );
  });

  it('runs one read-only Node 24 semantic shadow step before expensive suites', () => {
    const semanticMatches = qualityWorkflow.match(/name: Semantic quality \(shadow\)/g) ?? [];
    const semanticIndex = qualityWorkflow.indexOf('name: Semantic quality (shadow)');
    const suiteIndex = qualityWorkflow.indexOf('name: Test suite + coverage thresholds');

    expect(semanticMatches).toHaveLength(1);
    expect(semanticIndex).toBeGreaterThanOrEqual(0);
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

  it('uses the shared quality installer before Python-backed gates run', () => {
    const setupPythonIndex = qualityWorkflow.indexOf('name: Setup Python 3.12');
    const pythonDepsIndex = qualityWorkflow.indexOf('name: Host dependency profile (strict)');
    const tokenomicsIndex = qualityWorkflow.indexOf('name: Tokenomics Python tests');

    expect(setupPythonIndex).toBeGreaterThanOrEqual(0);
    expect(pythonDepsIndex).toBeGreaterThan(setupPythonIndex);
    expect(tokenomicsIndex).toBeGreaterThan(pythonDepsIndex);
    expect(qualityWorkflow).toMatch(/uses: actions\/setup-python@[0-9a-f]{40}/);
    expect(qualityWorkflow).toContain("python-version: '3.12'");
    expect(qualityWorkflow).toContain('install-host-dependencies.sh --profile quality --apply --yes --json');
    expect(qualityWorkflow).not.toContain('Install Python and Linux quality prerequisites');
    expect(qualityWorkflow).not.toContain('sudo apt-get install -y shellcheck ripgrep');
  });

  it('preserves exact required contexts while isolating Node 25 compatibility work', () => {
    const compatibilityStart = qualityWorkflow.indexOf('  compatibility-full:');
    const nextJob = qualityWorkflow.indexOf('  bot-errors-health-macos:', compatibilityStart);
    const compatibility = qualityWorkflow.slice(compatibilityStart, nextJob);

    expect(qualityWorkflow).toContain('name: quality (24.x)');
    expect(qualityWorkflow).toContain("node-version-file: '.nvmrc'");
    expect(compatibility).toContain('name: Quality full (25.x)');
    expect(qualityWorkflow).not.toContain('matrix:');
    expect(compatibility).toContain("node-version: '25.x'");
    expect(compatibility).toContain('run: node --experimental-strip-types scripts/full-suite-battery.ts --pool=forks');
    expect(compatibility).toContain('run: npm --prefix console run build');
    expect(compatibility).not.toContain('coverage:check');
    expect(compatibility).not.toContain('guard:');
    expect(compatibility).not.toContain('Playwright');
    expect(compatibility).not.toContain('Setup Python');
    expect(compatibility).not.toContain('test-integrity');
    expect(compatibility).not.toContain('ci-disk-reclaim');
  });

  it('requires strict and compatibility doctor receipts in the protected contexts', () => {
    expect(qualityWorkflow.match(/name: Host dependency profile \(strict\)/g)).toHaveLength(1);
    expect(qualityWorkflow.match(/name: Validate strict doctor receipt/g)).toHaveLength(1);
    expect(qualityWorkflow).toContain('set -o pipefail');
    expect(qualityWorkflow).toContain('whatsoup-doctor-quality.json');
    expect(qualityWorkflow.match(/name: Host dependency profile \(compatibility-only\)/g)).toHaveLength(1);
    expect(qualityWorkflow).toContain('--node-policy compatibility --json');
    expect(qualityWorkflow).toContain('whatsoup-doctor-compatibility.json');
  });

  it('runs measured disk enforcement only in the Node 24 authority job', () => {
    expect(qualityWorkflow.match(/bash scripts\/ci-disk-reclaim\.sh/g)).toHaveLength(1);
    expect(qualityWorkflow).not.toContain('sudo rm -rf /usr/share/dotnet');
    expect(qualityWorkflow).not.toContain('docker image prune --all --force || true');
  });

  it('runs branch-diff repo hygiene in CI before commit-author scanning', () => {
    const branchDiffIndex = qualityWorkflow.indexOf('npm run guard:repo:branch-diff');
    const commitAuthorIndex = qualityWorkflow.indexOf('npm run guard:repo:commit-authors');

    expect(branchDiffIndex).toBeGreaterThanOrEqual(0);
    expect(commitAuthorIndex).toBeGreaterThan(branchDiffIndex);
    expect(qualityWorkflow).toContain('--base "origin/$GITHUB_BASE_REF"');
  });

  it('fetches one fail-closed PR base snapshot before every authority consumer', () => {
    const fullStart = qualityWorkflow.indexOf('  full:');
    const compatibilityIndex = qualityWorkflow.indexOf('  compatibility-full:', fullStart);
    const authority = qualityWorkflow.slice(fullStart, compatibilityIndex);
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
    const fullStart = qualityWorkflow.indexOf('  full:');
    const compatibilityIndex = qualityWorkflow.indexOf('  compatibility-full:', fullStart);
    const authority = qualityWorkflow.slice(fullStart, compatibilityIndex);
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

  it('keeps the standalone Node 25 guard package compatibility workflow', () => {
    expect(whatsoupGuardWorkflow).toContain("node: ['25.x']");
    expect(whatsoupGuardWorkflow).not.toContain("'24.x'");
    expect(whatsoupGuardWorkflow).toContain('node-version: ${{ matrix.node }}');
    expect(whatsoupGuardWorkflow).toContain('run: npm run typecheck');
    expect(whatsoupGuardWorkflow).toContain('run: npm test');
    expect(whatsoupGuardWorkflow).not.toContain('npm run coverage:proof');
  });

});
