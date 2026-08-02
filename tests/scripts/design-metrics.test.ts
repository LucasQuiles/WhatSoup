import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

// Path to the script under test (resolved from repo root = process.cwd())
const SCRIPT = resolve(process.cwd(), 'console/scripts/design-metrics.mjs');

const tmp = trackTmpDirs('design-');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;         // fake repo root
  consoleDir: string;   // fake console/
  docsDir: string;      // fake docs/design-system/06-implementation/
}

const DEFAULT_WAIVERS = `waivers:
  - id: WVR-001
    rule: soup/no-untokenized-values
    owner: console-maintainer
    reason: test waiver A
    scope:
      - console/src/lib/chart-utils.ts
    expiry: 2099-12-31
    replacement_plan: retire at P3
    safer_alternative_considered: none
    status: temporary
    expiration_phase: C3
    cleanup_trigger: chart slice
    user_approval_required: no
  - id: WVR-002
    rule: soup/no-raw-color
    owner: console-maintainer
    reason: test waiver B
    scope:
      - console/src/components/QrDisplay.tsx
    expiry: 2099-12-31
    replacement_plan: retire at P4
    safer_alternative_considered: none
    status: temporary
    expiration_phase: C4
    cleanup_trigger: QR slice
    user_approval_required: no
`;

const DEFAULT_DEBT_REGISTER = `# Design Debt Register

| ID | Title | Area | Type | Sev | Reason | Workaround | Owner / next step | Cleanup phase | Expiration condition | Blocks final acceptance? |
|---|---|---|---|---|---|---|---|---|---|---|
| DD-5 | Theme toggle | component | component | P3 | pending | functional | C3 | C3 | slice merged | no |
| DD-8 | text-3 audit | color | accessibility | P2 | conflict | resolved | C3 | C3 | confirmed | YES |

## Closed

| ID | Title | Closed by | Evidence |
|---|---|---|---|
| DD-6 | Status shape | C2.1 | evidence.md |
| DD-7 | Modal focus | C2.2 | evidence.md |
`;

const DEFAULT_BASELINE = {
  generated: 'shadow lint per-rule warning ceiling',
  total: 10,
  rules: {
    'soup/no-raw-button :: src/components/Foo.tsx': 3,
    'soup/no-legacy-tokens :: src/components/Bar.tsx': 7,
  },
};

/**
 * Build a minimal temp-dir fixture tree that design-metrics.mjs expects.
 * Paths are redirected via DESIGN_METRICS_CONSOLE_ROOT and DESIGN_METRICS_REPO_ROOT.
 */
function makeFixture(opts: {
  baseline?: object;
  waivers?: string;
  debtRegister?: string;
  regressionStub?: string;
} = {}): Fixture {
  const root = tmp.make('metrics');

  const consoleDir = join(root, 'console');
  const scriptsDir = join(consoleDir, 'scripts');
  const docsDir = join(root, 'docs', 'design-system', '06-implementation');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });

  const baseline = opts.baseline ?? DEFAULT_BASELINE;
  writeFileSync(
    join(consoleDir, 'lint-shadow-baseline.json'),
    JSON.stringify(baseline, null, 2)
  );

  writeFileSync(join(consoleDir, 'eslint-waivers.yaml'), opts.waivers ?? DEFAULT_WAIVERS);

  writeFileSync(join(docsDir, 'design-debt-register.md'), opts.debtRegister ?? DEFAULT_DEBT_REGISTER);

  // Stub design-regression.sh — must not run real eslint; just emit deterministic output.
  const regressionStub = opts.regressionStub ?? `#!/usr/bin/env bash
echo "--- Check 1: Raw hex colors"
echo "    PASS  count=0  (zero raw hex colors)"
echo ""
echo "--- Check 2: Raw rgb"
echo "    PASS  count=0  (zero)"
echo ""
echo "--- Check 14: Expired waivers"
echo "    PASS  count=0  (no expired waivers)"
echo ""
echo "  SUMMARY"
echo "  Checks passed:  3"
echo "  Checks warned:  0"
exit 0
`;
  const stubPath = join(scriptsDir, 'design-regression.sh');
  writeFileSync(stubPath, regressionStub);
  chmodSync(stubPath, 0o755);

  return { root, consoleDir, docsDir };
}

/**
 * Run the design-metrics.mjs script with fixtures redirected via env vars.
 * The live eslint shadow run will fail (no node_modules in fixture) and the
 * script handles that gracefully (liveRunError, continues).
 */
function runScript(fixture: Fixture, extraArgs: string[] = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    env: {
      ...process.env,
      DESIGN_METRICS_CONSOLE_ROOT: fixture.consoleDir,
      DESIGN_METRICS_REPO_ROOT: fixture.root,
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    // No timeout — let vitest's test timeout handle it; we don't want spawnSync hanging
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('design-metrics.mjs', () => {
  describe('valid fixture', () => {
    it('exits 0 when all inputs are valid and no waivers expired', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('outputs valid JSON to stdout', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('JSON output contains required top-level keys', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toHaveProperty('schema_version');
      expect(output).toHaveProperty('shadow_ratchet');
      expect(output).toHaveProperty('design_regression');
      expect(output).toHaveProperty('waivers');
      expect(output).toHaveProperty('debt_register');
    });

    it('shadow_ratchet contains stale_ceiling_keys and stale_ceiling_count', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        shadow_ratchet: Record<string, unknown>;
      };
      // Both keys must be present in the schema even when live run fails
      expect(output.shadow_ratchet).toHaveProperty('stale_ceiling_keys');
      expect(output.shadow_ratchet).toHaveProperty('stale_ceiling_count');
    });

    it('shadow_ratchet reflects the fixture baseline totals', () => {
      const fixture = makeFixture({
        baseline: {
          generated: 'shadow lint per-rule warning ceiling',
          total: 42,
          rules: {
            'soup/no-raw-button :: src/Foo.tsx': 10,
            'soup/no-legacy-tokens :: src/Bar.tsx': 32,
          },
        },
      });
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        shadow_ratchet: { baseline_total: number; baseline_by_rule: Record<string, number> };
      };
      expect(output.shadow_ratchet.baseline_total).toBe(42);
      expect(output.shadow_ratchet.baseline_by_rule['soup/no-raw-button']).toBe(10);
      expect(output.shadow_ratchet.baseline_by_rule['soup/no-legacy-tokens']).toBe(32);
    });

    it('waivers active_count matches fixture (2 active, 0 expired)', () => {
      const fixture = makeFixture(); // DEFAULT_WAIVERS has 2 waivers, both 2099 expiry
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        waivers: { active_count: number; expired_count: number };
      };
      expect(output.waivers.active_count).toBe(2);
      expect(output.waivers.expired_count).toBe(0);
    });

    it('debt_register open/closed counts match fixture (2 open, 2 closed)', () => {
      const fixture = makeFixture(); // DEFAULT_DEBT_REGISTER has DD-5/DD-8 open, DD-6/DD-7 closed
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        debt_register: { open_count: number; closed_count: number };
      };
      expect(output.debt_register.open_count).toBe(2);
      expect(output.debt_register.closed_count).toBe(2);
    });

    it('design_regression reflects stub output (3 pass, 0 warn, 0 fail)', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        design_regression: { pass: number; warn: number; fail: number };
      };
      expect(output.design_regression.pass).toBe(3);
      expect(output.design_regression.warn).toBe(0);
      expect(output.design_regression.fail).toBe(0);
    });

    it('output keys are sorted at the top level', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const keys = Object.keys(output);
      expect(keys).toEqual([...keys].sort());
    });

    it('output is deterministic — two sequential runs produce identical JSON structure', () => {
      const fixture = makeFixture();
      const r1 = runScript(fixture);
      const r2 = runScript(fixture);

      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
      const o1 = JSON.parse(r1.stdout) as Record<string, unknown>;
      const o2 = JSON.parse(r2.stdout) as Record<string, unknown>;
      // Structural keys must be identical
      expect(Object.keys(o1).sort()).toEqual(Object.keys(o2).sort());
      // Baseline-derived values (no live eslint) must be byte-identical
      const sr1 = (o1.shadow_ratchet as Record<string, unknown>);
      const sr2 = (o2.shadow_ratchet as Record<string, unknown>);
      expect(sr1.baseline_total).toBe(sr2.baseline_total);
      expect(JSON.stringify(sr1.baseline_by_rule)).toBe(JSON.stringify(sr2.baseline_by_rule));
      expect((o1.waivers as Record<string, unknown>).active_count).toBe(
        (o2.waivers as Record<string, unknown>).active_count
      );
    });
  });

  describe('expired waivers', () => {
    it('exits 1 when a waiver expiry is in the past', () => {
      const fixture = makeFixture({
        waivers: `waivers:
  - id: WVR-001
    rule: soup/no-untokenized-values
    owner: console-maintainer
    reason: expired test
    scope:
      - console/src/lib/chart-utils.ts
    expiry: 2000-01-01
    replacement_plan: retire it
    safer_alternative_considered: none
    status: temporary
    expiration_phase: C3
    cleanup_trigger: chart slice
    user_approval_required: no
`,
      });
      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('expired-waivers');
      expect(result.stderr).toContain('WVR-001');
    });

    it('reports expired waiver id in JSON output even when exiting 1', () => {
      const fixture = makeFixture({
        waivers: `waivers:
  - id: WVR-EXPIRED
    rule: soup/no-raw-button
    owner: console-maintainer
    reason: test
    scope:
      - console/src/Foo.tsx
    expiry: 2020-06-01
    replacement_plan: retire
    safer_alternative_considered: none
    status: temporary
    expiration_phase: D6
    cleanup_trigger: slice
    user_approval_required: no
`,
      });
      const result = runScript(fixture);

      expect(result.status).toBe(1);
      // stdout still carries the JSON (written before expiry check)
      const output = JSON.parse(result.stdout) as {
        waivers: { expired_count: number; expired_ids: string[] };
      };
      expect(output.waivers.expired_count).toBe(1);
      expect(output.waivers.expired_ids).toContain('WVR-EXPIRED');
    });

    it('counts active vs expired waivers correctly when both are present', () => {
      const fixture = makeFixture({
        waivers: `waivers:
  - id: WVR-ACTIVE
    rule: soup/no-raw-button
    owner: console-maintainer
    reason: active
    scope:
      - console/src/Foo.tsx
    expiry: 2099-12-31
    replacement_plan: future
    safer_alternative_considered: none
    status: temporary
    expiration_phase: C3
    cleanup_trigger: slice
    user_approval_required: no
  - id: WVR-DEAD
    rule: soup/no-legacy-tokens
    owner: console-maintainer
    reason: expired
    scope:
      - console/src/Bar.tsx
    expiry: 2001-01-01
    replacement_plan: none
    safer_alternative_considered: none
    status: temporary
    expiration_phase: C2
    cleanup_trigger: slice
    user_approval_required: no
`,
      });
      const result = runScript(fixture);

      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout) as {
        waivers: { active_count: number; expired_count: number };
      };
      expect(output.waivers.active_count).toBe(1);
      expect(output.waivers.expired_count).toBe(1);
    });
  });

  describe('fail-closed parsing', () => {
    it('exits 1 with named error when baseline JSON is malformed', () => {
      const fixture = makeFixture();
      writeFileSync(
        join(fixture.consoleDir, 'lint-shadow-baseline.json'),
        '{ "total": 10, "rules": { INVALID JSON }'
      );

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(parse:lint-shadow-baseline.json)');
    });

    it('exits 1 with named error when baseline file is missing', () => {
      const fixture = makeFixture();
      rmSync(join(fixture.consoleDir, 'lint-shadow-baseline.json'));

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(read:lint-shadow-baseline.json)');
    });

    it('exits 1 with named error when baseline lacks "total" field', () => {
      const fixture = makeFixture({
        baseline: { generated: 'test', rules: {} } as object,
      });

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(schema:lint-shadow-baseline.json)');
      expect(result.stderr).toContain('total');
    });

    it('exits 1 with named error when baseline key lacks " :: " separator', () => {
      const fixture = makeFixture({
        baseline: {
          generated: 'test',
          total: 1,
          rules: { 'bad-key-no-separator': 1 },
        },
      });

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(schema:lint-shadow-baseline.json)');
      expect(result.stderr).toContain('separator');
    });

    it('exits 1 with named error when waivers file is missing', () => {
      const fixture = makeFixture();
      rmSync(join(fixture.consoleDir, 'eslint-waivers.yaml'));

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(read:eslint-waivers.yaml)');
    });

    it('exits 1 with named error when a waiver block has no expiry field', () => {
      const fixture = makeFixture({
        waivers: `waivers:
  - id: WVR-NOEXPIRY
    rule: soup/no-raw-button
    owner: console-maintainer
    reason: missing expiry
    scope:
      - console/src/Foo.tsx
    replacement_plan: none
    safer_alternative_considered: none
    status: temporary
    expiration_phase: C3
    cleanup_trigger: slice
    user_approval_required: no
`,
      });

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(parse:eslint-waivers.yaml)');
      expect(result.stderr).toContain('WVR-NOEXPIRY');
    });

    it('exits 1 with named error when debt register file is missing', () => {
      const fixture = makeFixture();
      rmSync(join(fixture.docsDir, 'design-debt-register.md'));

      const result = runScript(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(read:design-debt-register.md)');
    });
  });

  describe('--out flag', () => {
    it('writes output to the specified file when --out is given', () => {
      const fixture = makeFixture();
      const outPath = join(fixture.root, 'metrics-output.json');

      const result = runScript(fixture, ['--out', outPath]);

      expect(result.status).toBe(0);
      const { readFileSync } = require('node:fs');
      const fileContent = readFileSync(outPath, 'utf8') as string;
      expect(() => JSON.parse(fileContent)).not.toThrow();
      // stdout and file content should match
      expect(fileContent.trim()).toBe(result.stdout.trim());
    });

    it('exits 1 with named error when --out path is unwritable', () => {
      const fixture = makeFixture();
      const badPath = '/no/such/directory/metrics.json';

      const result = runScript(fixture, ['--out', badPath]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(write:');
    });

    it('exits 1 with named error when --out is given with no path argument', () => {
      const fixture = makeFixture();

      const result = runScript(fixture, ['--out']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(args)');
    });
  });

  describe('debt register parsing', () => {
    it('counts zero open and zero closed with no DD- rows', () => {
      const fixture = makeFixture({
        debtRegister: `# Design Debt Register

| ID | Title | Area | Type | Sev | Reason | Workaround | Owner / next step | Cleanup phase | Expiration condition | Blocks final acceptance? |
|---|---|---|---|---|---|---|---|---|---|---|

## Closed

| ID | Title | Closed by | Evidence |
|---|---|---|---|
`,
      });
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        debt_register: { open_count: number; closed_count: number; total_count: number };
      };
      expect(output.debt_register.open_count).toBe(0);
      expect(output.debt_register.closed_count).toBe(0);
      expect(output.debt_register.total_count).toBe(0);
    });

    it('counts multiple open items and zero closed', () => {
      const fixture = makeFixture({
        debtRegister: `# Design Debt Register

| ID | Title | Area | Type | Sev | Reason | Workaround | Owner / next step | Cleanup phase | Expiration condition | Blocks final acceptance? |
|---|---|---|---|---|---|---|---|---|---|---|
| DD-1 | First | a | b | P1 | reason | workaround | owner | C1 | condition | no |
| DD-2 | Second | a | b | P2 | reason | workaround | owner | C2 | condition | no |
| DD-3 | Third | a | b | P3 | reason | workaround | owner | C3 | condition | no |

## Closed

| ID | Title | Closed by | Evidence |
|---|---|---|---|
`,
      });
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        debt_register: { open_count: number; closed_count: number };
      };
      expect(output.debt_register.open_count).toBe(3);
      expect(output.debt_register.closed_count).toBe(0);
    });
  });

  describe('stale ceiling detection', () => {
    // When the live eslint run fails (no node_modules in fixture), stale_ceiling_keys
    // and stale_ceiling_count must be null — the script must not fabricate stale-ceiling
    // findings without real live data.
    it('stale ceiling fields are null (not zero, not {}) when live run fails', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const sr = (JSON.parse(result.stdout) as { shadow_ratchet: Record<string, unknown> }).shadow_ratchet;
      // Must be exactly null, not 0, not an empty object — null signals "no live data"
      expect(sr.stale_ceiling_keys).toStrictEqual(null);
      expect(sr.stale_ceiling_count).toStrictEqual(null);
    });

    it('stale ceiling fields are present in JSON schema even when null', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const sr = output.shadow_ratchet as Record<string, unknown>;
      // Keys must be present in the emitted object regardless of value
      expect(Object.keys(sr)).toContain('stale_ceiling_keys');
      expect(Object.keys(sr)).toContain('stale_ceiling_count');
    });

    it('does not block a push on its own: exits 0 and emits no ERROR token to stderr', () => {
      // The stale ceiling is WARN-level only. Even when stale ceiling keys exist,
      // the script must exit 0 and must not write ERROR(...) to stderr.
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/^ERROR\(/m);
    });

    it('stale ceiling WARN goes to stderr only; stdout remains valid parseable JSON', () => {
      // Any WARN output must land on stderr so callers can separate structured data
      // from advisory messages. stdout must be machine-readable JSON end-to-end.
      const fixture = makeFixture();
      const result = runScript(fixture);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toHaveProperty('shadow_ratchet');
    });

    it('stale_ceiling_keys is null (not an empty array) when live run is unavailable', () => {
      // The contract distinguishes "no live data" (null) from "live data, zero stale
      // keys" (empty object {}). Fixture has no eslint, so live run fails → null.
      const fixture = makeFixture();
      const result = runScript(fixture);

      expect(result.status).toBe(0);
      const sr = (JSON.parse(result.stdout) as { shadow_ratchet: Record<string, unknown> }).shadow_ratchet;
      expect(sr.stale_ceiling_keys).toStrictEqual(null);
    });

    it('determinism: stale_ceiling fields are stable across two runs', () => {
      const fixture = makeFixture();
      const r1 = runScript(fixture);
      const r2 = runScript(fixture);

      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
      const o1 = JSON.parse(r1.stdout) as { shadow_ratchet: Record<string, unknown> };
      const o2 = JSON.parse(r2.stdout) as { shadow_ratchet: Record<string, unknown> };
      expect(JSON.stringify(o1.shadow_ratchet.stale_ceiling_keys)).toBe(
        JSON.stringify(o2.shadow_ratchet.stale_ceiling_keys)
      );
      expect(o1.shadow_ratchet.stale_ceiling_count).toBe(o2.shadow_ratchet.stale_ceiling_count);
    });
  });
});
