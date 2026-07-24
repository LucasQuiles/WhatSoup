import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'console/scripts/design-regression.sh');
const WAIVER_SYNC_SCRIPT = resolve(process.cwd(), 'console/scripts/check-waiver-sync.mjs');
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function runScript() {
  return spawnSync('bash', [SCRIPT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function makeWaiverFixture(opts: {
  source?: string;
  waivers?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'waiver-sync-'));
  tmpDirs.push(root);

  const consoleDir = join(root, 'console');
  const srcDir = join(consoleDir, 'src');
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    join(srcDir, 'Fixture.tsx'),
    opts.source ??
      `/* eslint-disable react-hooks/set-state-in-effect -- waiver:WVR-001 test fixture; expires 2099-12-31 */\nexport const Fixture = 1;\n`,
  );
  writeFileSync(
    join(consoleDir, 'eslint-waivers.yaml'),
    opts.waivers ??
      [
        'waivers:',
        '  - id: WVR-001',
        '    rule: react-hooks/set-state-in-effect',
        '    owner: test-fixture',
        '    reason: test fixture only.',
        '    scope: console/src/Fixture.tsx',
        '    expiry: 2099-12-31',
        '    replacement_plan: retire with the fixture.',
        '    safer_alternative_considered: none — test only.',
        '    status: temporary',
        '    expiration_phase: C1',
        '    cleanup_trigger: fixture removed',
        '    user_approval_required: no',
      ].join('\n') + '\n',
  );

  return consoleDir;
}

function runWaiverSync(consoleRoot: string) {
  return spawnSync('node', [WAIVER_SYNC_SCRIPT, '--console-root', consoleRoot], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function makeDesignRegressionFixture(componentCss: string) {
  const root = mkdtempSync(join(tmpdir(), 'design-regression-'));
  tmpDirs.push(root);

  const consoleDir = join(root, 'console');
  const scriptsDir = join(consoleDir, 'scripts');
  const srcDir = join(consoleDir, 'src');
  const stylesDir = join(srcDir, 'styles');
  const libDir = join(srcDir, 'lib');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(stylesDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  mkdirSync(join(srcDir, 'components'), { recursive: true });
  mkdirSync(join(srcDir, 'pages'), { recursive: true });

  copyFileSync(SCRIPT, join(scriptsDir, 'design-regression.sh'));
  writeFileSync(join(consoleDir, 'index.html'), '<title>SOUP Console</title>\n');
  writeFileSync(join(libDir, 'preferences.ts'), "export const key = 'whatsoup:preferences';\n");
  writeFileSync(join(srcDir, 'mock-data.ts'), "export const socket = '/run/whatsoup/agent.sock';\n");
  writeFileSync(join(libDir, 'agent-cwd.ts'), "export const path = 'whatsoup/instances/demo';\n");
  writeFileSync(
    join(scriptsDir, 'check-waiver-sync.mjs'),
    `console.log(JSON.stringify({
  issue_count: 0,
  registered_count: 0,
  source_tag_count: 0,
  untagged_count: 0,
  unknown_source_ids: [],
  stale_registry_scope_count: 0,
  untagged_suppressions: [],
  stale_registry_scopes: []
}));\n`,
  );
  writeFileSync(join(stylesDir, 'tokens.primitive.css'), ':root {\n  --font-sans: system-ui;\n}\n');
  writeFileSync(join(stylesDir, 'tokens.semantic.css'), ':root {\n  --color-token: var(--font-sans);\n}\n');
  writeFileSync(join(stylesDir, 'tokens.component.css'), ':root {\n  --shadow-token: var(--color-token);\n}\n');
  writeFileSync(join(stylesDir, 'primitives.css'), componentCss);
  writeFileSync(join(stylesDir, 'composites.css'), '.fixture { color: var(--color-token); }\n');

  return join(scriptsDir, 'design-regression.sh');
}

function runDesignRegressionFixture(componentCss: string) {
  return spawnSync('bash', [makeDesignRegressionFixture(componentCss)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function checkBlock(output: string, checkNumber: number): string {
  const start = output.indexOf(`--- Check ${checkNumber}:`);
  const next = output.indexOf(`--- Check ${checkNumber + 1}:`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return output.slice(start, next === -1 ? undefined : next);
}

describe('design-regression.sh guard contracts', () => {
  it('keeps the promoted blocking check list explicit', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('EXIT_ON_FAIL=(1 2 6 8 10 11 12 13 14 15 16 17 19)');
  });

  it('reports zero focus-suppression hits as a clean blocking PASS', () => {
    const result = runScript();
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain('integer expected');
    expect(output).toContain('Blocking checks: 1 2 6 8 10 11 12 13 14 15 16 17 19 (all PASS)');

    const check12 = checkBlock(output, 12);
    expect(check12).toContain('outline-none without focus-visible: count: 0');
    expect(check12).toContain('PASS  count=0  (zero focus suppression sites)');
  });

  it('fails a fixture repo when CSS uses an unsanctioned infinite animation', () => {
    const result = runDesignRegressionFixture(
      '.fixture { animation: spin 1s linear infinite; color: var(--color-token); }\n',
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);

    const check13 = checkBlock(output, 13);
    expect(check13).toContain("'infinite' occurrences in CSS: 1");
    expect(check13).toContain('UNSANCTIONED');
    expect(check13).toContain('spin 1s linear infinite');
    expect(check13).toContain('FAIL  count=1  (1 unsanctioned infinite animations)');
    expect(output).toContain('BLOCKING checks failed: 13');
  });

  it('allows a fixture repo when CSS infinite animations use sanctioned names', () => {
    // T5 b-11: the sanctioned set tightened to ambient-disc ONLY (13-§1).
    const result = runDesignRegressionFixture(
      '.fixture { animation: ambient-disc 2400ms ease-in-out infinite; color: var(--color-token); }\n',
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);

    const check13 = checkBlock(output, 13);
    expect(check13).toContain("'infinite' occurrences in CSS: 1");
    expect(check13).not.toContain('UNSANCTIONED');
    expect(check13).toContain('PASS  count=1  (all 1 occurrences are waivered/sanctioned)');
  });

  it('reports dangling no-fallback CSS var refs as a clean blocking PASS when absent', () => {
    const result = runScript();
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);

    const check19 = checkBlock(output, 19);
    expect(check19).toContain('Dangling var() refs (no fallback, no CSS definition): 0');
    expect(check19).toContain('Lifecycle: BLOCKING');
    expect(check19).toContain('PASS  count=0  (no dangling var() refs without fallback)');
  });

  it('fails a fixture repo when component CSS references an undefined var without fallback', () => {
    const result = runDesignRegressionFixture(
      '.fixture { color: var(--color-token); border-color: var(--missing-token); }\n',
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);

    const check19 = checkBlock(output, 19);
    expect(check19).toContain('Dangling var() refs (no fallback, no CSS definition): 1');
    expect(check19).toContain('--missing-token');
    expect(check19).toContain('FAIL  count=1');
    expect(output).toContain('BLOCKING checks failed: 19');
  });

  it('allows fixture CSS refs that provide an explicit fallback', () => {
    const result = runDesignRegressionFixture(
      '.fixture { color: var(--color-token); border-color: var(--runtime-token, var(--color-token)); }\n',
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);

    const check19 = checkBlock(output, 19);
    expect(check19).toContain('Dangling var() refs (no fallback, no CSS definition): 0');
    expect(check19).toContain('PASS  count=0  (no dangling var() refs without fallback)');
  });

  it('reports waiver registry/source sync as a clean blocking PASS', () => {
    const result = runScript();
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);

    const check15 = checkBlock(output, 15);
    // Derive the expected count from the live registry so adding a waiver
    // doesn't drift this pin (the registry file is the SSOT).
    const registryCount = (readFileSync(resolve(process.cwd(), 'console/eslint-waivers.yaml'), 'utf8').match(/^  - id: WVR-/gm) ?? []).length;
    expect(check15).toContain(`Registered waivers: ${registryCount}`);
    // Independent literal so the derived pin above can't pass vacuously against
    // an empty/unparsed registry. 9 = the v3.5 set after b-11 retired
    // WVR-005/006 with their subjects (T5 b-13 integration).
    expect(check15).toContain('Registered waivers: 9');
    expect(check15).toContain('Untagged disable directives: 0');
    expect(check15).toContain('Unknown source waiver ids: 0');
    expect(check15).toContain('Stale registry TS/TSX scopes: 0');
    expect(check15).toContain('PASS  count=0  (waiver registry and source suppression tags in sync)');
  });

  it('waiver sync passes when source tags and registry scopes agree', () => {
    const consoleRoot = makeWaiverFixture();
    const result = runWaiverSync(consoleRoot);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      verdict: string;
      issue_count: number;
      source_tag_count: number;
      registered_count: number;
    };
    expect(output.verdict).toBe('PASS');
    expect(output.issue_count).toBe(0);
    expect(output.source_tag_count).toBe(1);
    expect(output.registered_count).toBe(1);
  });

  it('waiver sync fails when a source tag is absent from eslint-waivers.yaml', () => {
    const consoleRoot = makeWaiverFixture({
      source:
        `/* eslint-disable react-hooks/set-state-in-effect -- waiver:WVR-999 test fixture; expires 2099-12-31 */\nexport const Fixture = 1;\n`,
    });
    const result = runWaiverSync(consoleRoot);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as {
      verdict: string;
      unknown_source_ids: string[];
    };
    expect(output.verdict).toBe('FAIL');
    expect(output.unknown_source_ids).toContain('WVR-999');
  });

  it('waiver sync fails when a TS/TSX registry scope has no matching source tag in that file', () => {
    const consoleRoot = makeWaiverFixture({
      waivers:
        `waivers:\n  - id: WVR-001\n    scope: console/src/Other.tsx\n    expiry: 2099-12-31\n`,
    });
    const result = runWaiverSync(consoleRoot);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as {
      verdict: string;
      stale_registry_scopes: Array<{ id: string; scope_file: string }>;
    };
    expect(output.verdict).toBe('FAIL');
    expect(output.stale_registry_scopes).toContainEqual({
      id: 'WVR-001',
      scope_file: 'console/src/Other.tsx',
    });
  });
});
