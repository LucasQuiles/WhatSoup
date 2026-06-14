import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-design-lint-fixtures.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

interface FixtureOverrides {
  designLints?: string;
  lintPlan?: string;
  plugin?: string;
  selectors?: string;
  shadowConfig?: string;
}

function makeFixture(overrides: FixtureOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'design-lint-fixtures-'));
  tmpDirs.push(dir);
  const paths = {
    designLints: join(dir, 'design-lints.test.ts'),
    lintPlan: join(dir, 'lint-plan.md'),
    plugin: join(dir, 'index.mjs'),
    selectors: join(dir, 'design-selectors.mjs'),
    shadowConfig: join(dir, 'eslint.config.shadow.mjs'),
  };
  writeFileSync(paths.designLints, overrides.designLints ?? fixtureDesignLints());
  writeFileSync(paths.lintPlan, overrides.lintPlan ?? fixtureLintPlan());
  writeFileSync(paths.plugin, overrides.plugin ?? fixturePlugin());
  writeFileSync(paths.selectors, overrides.selectors ?? fixtureSelectors());
  writeFileSync(paths.shadowConfig, overrides.shadowConfig ?? fixtureShadowConfig());
  return paths;
}

function fixtureSelectors() {
  return `
export const structuralSelectors = [
  { message: '[soup/no-raw-table] Raw <table> element.' },
]
`;
}

function fixtureShadowConfig() {
  return `
const shadowSyntaxRules = [
  { message: '[soup/no-raw-form-control SHADOW] Raw form control element.' },
]
`;
}

function fixturePlugin() {
  return `
const noBrandRegression = {
  meta: {
    messages: {
      jsxText: '[soup/no-brand-regression] "WhatSoup" in JSX text.',
    },
  },
}
const noInlineDismissHandler = makeStub(
  '[stub] soup/no-inline-dismiss-handler — SHADOW. Enabled with useDismissable hook.'
)
export default {
  rules: {
    'no-brand-regression': noBrandRegression,
    'no-inline-dismiss-handler': noInlineDismissHandler,
  },
}
`;
}

function fixtureLintPlan() {
  return `
| soup/no-raw-table | scoped-error | global-error |
| soup/no-raw-form-control | shadow | scoped-error |
| soup/no-brand-regression | shadow | global-error |
| soup/no-inline-dismiss-handler | shadow | global-error |
`;
}

function fixtureDesignLints() {
  return `
describe('soup/no-raw-table', () => {
  it('fires on raw table', () => {})
  it('is silent on DataTable', () => {})
})

// ---------------------------------------------------------------------------

describe('soup/no-raw-form-control', () => {
  it('fires on raw input', () => {})
  it('is silent on InputField', () => {})
})

// ---------------------------------------------------------------------------

describe('soup/no-brand-regression', () => {
  it('fires on WhatSoup copy', () => {})
  it('is silent on protected copy', () => {})
})

// ===========================================================================

describe('promoted-path probes', () => {
  it('no-raw-table fires as error', () => {
    expect(hasError(messages, 'no-raw-table')).toBe(true)
  })
})
`;
}

function runScript(paths = makeFixture()) {
  return spawnSync(
    'node',
    [
      SCRIPT,
      '--design-lints',
      paths.designLints,
      '--selectors',
      paths.selectors,
      '--plugin',
      paths.plugin,
      '--shadow-config',
      paths.shadowConfig,
      '--lint-plan',
      paths.lintPlan,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    failures: Array<{ code: string; rule: string }>;
    implemented_rules: string[];
    plugin_registered_rules: string[];
    promoted_selector_rules: string[];
    stub_rules: string[];
    undocumented_stub_rules: string[];
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-design-lint-fixtures.mjs', () => {
  it('passes when implemented rules have lint-plan rows, firing fixtures, silent fixtures, and promoted probes', () => {
    const result = runScript();
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.implemented_rules).toEqual([
      'no-brand-regression',
      'no-raw-form-control',
      'no-raw-table',
    ]);
    expect(output.plugin_registered_rules).toEqual([
      'no-brand-regression',
      'no-inline-dismiss-handler',
    ]);
    expect(output.promoted_selector_rules).toEqual(['no-raw-table']);
    expect(output.stub_rules).toEqual(['no-inline-dismiss-handler']);
    expect(output.undocumented_stub_rules).toEqual([]);
  });

  it('fails when an implemented rule lacks a fixture suite', () => {
    const paths = makeFixture({
      designLints: fixtureDesignLints().replace(/describe\('soup\/no-brand-regression'[\s\S]*?\/\/ ===========================================================================/, '// ==========================================================================='),
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_FIXTURE_SUITE:no-brand-regression');
  });

  it('fails when a lifecycle table row is missing even if the rule is mentioned elsewhere', () => {
    const paths = makeFixture({
      lintPlan: `${fixtureLintPlan().replace('| soup/no-raw-table | scoped-error | global-error |\n', '')}
### soup/no-raw-table
Documented outside the lifecycle table.
`,
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_LINT_PLAN_ROW:no-raw-table');
  });

  it('fails when a fixture suite lacks a silent case', () => {
    const paths = makeFixture({
      designLints: fixtureDesignLints().replace("  it('is silent on InputField', () => {})\n", ''),
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_SILENT_FIXTURE:no-raw-form-control');
  });

  it('fails when a promoted selector rule lacks an error-severity probe', () => {
    const paths = makeFixture({
      designLints: fixtureDesignLints().replace("expect(hasError(messages, 'no-raw-table')).toBe(true)", 'const ignoredProbe = messages.length'),
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_PROMOTED_ERROR_PROBE:no-raw-table');
  });

  it('fails when a promoted selector rule only has a silent error probe', () => {
    const paths = makeFixture({
      designLints: fixtureDesignLints().replace("expect(hasError(messages, 'no-raw-table')).toBe(true)", "expect(hasError(messages, 'no-raw-table')).toBe(false)"),
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_PROMOTED_ERROR_PROBE:no-raw-table');
  });

  it('fails when a stub rule lacks a lint-plan row', () => {
    const paths = makeFixture({
      lintPlan: fixtureLintPlan().replace('| soup/no-inline-dismiss-handler | shadow | global-error |\n', ''),
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_STUB_LINT_PLAN_ROW:no-inline-dismiss-handler');
  });

  it('fails when a registered plugin stub lacks a stub doc marker', () => {
    const paths = makeFixture({
      plugin: fixturePlugin().replace(
        '[stub] soup/no-inline-dismiss-handler — SHADOW. Enabled with useDismissable hook.',
        'shadow no-inline-dismiss-handler missing the soup stub marker.',
      ),
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('MISSING_STUB_DOC:no-inline-dismiss-handler');
  });

  it('fails when an implemented rule is still declared as a zero-fire stub', () => {
    const paths = makeFixture({
      plugin: `${fixturePlugin()}
const noRawTable = makeStub('[stub] soup/no-raw-table — stale duplicate stub.')
`,
    });
    const result = runScript(paths);
    const output = parsedOutput(result);
    const failureKeys = output.failures.map((failure) => `${failure.code}:${failure.rule}`);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(failureKeys).toContain('IMPLEMENTED_RULE_STILL_STUB:no-raw-table');
  });

  it('passes the live repository design-lint fixture contract', () => {
    const result = spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.implemented_rules.length).toBeGreaterThanOrEqual(10);
    expect(output.stub_rules.length).toBeGreaterThanOrEqual(4);
  });
});
