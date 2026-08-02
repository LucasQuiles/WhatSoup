import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-design-resilience.mjs');
const PROMOTED_RULES = [
  'soup/layer-owner-required',
  'soup/no-hover-only-content',
  'soup/no-layout-shift-interaction',
  'soup/no-raw-css-focus-suppression',
  'soup/no-raw-viewport-js',
  'soup/no-static-viewport-height',
  'soup/no-unsafe-truncation',
  'soup/no-vw-font-size',
  'soup/scroll-owner-required',
];

const tmp = trackTmpDirs('');

function makeFixture(source: string, filePath = 'console/src/Fixture.tsx') {
  const root = tmp.make('design-resilience');
  const absolute = join(root, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
  return root;
}

function runScript(root: string, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [SCRIPT, '--root', root, '--max-findings', '50', ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function promotedRuleArgs() {
  return PROMOTED_RULES.flatMap((rule) => ['--fail-on-rule', rule]);
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    by_rule: Record<string, number>;
    enforced_rules: string[];
    failed_rules: string[];
    finding_count: number;
    findings: Array<{ rule: string; file: string; line: number }>;
    mode: 'report-only' | 'fail-on-findings' | 'fail-on-rule';
    scanned_file_count: number;
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-design-resilience.mjs', () => {
  it('promotes every zeroed resilience lane through the package script', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'console/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/layer-owner-required');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-hover-only-content');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-layout-shift-interaction');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-raw-css-focus-suppression');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-raw-viewport-js');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-static-viewport-height');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-unsafe-truncation');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/no-vw-font-size');
    expect(pkg.scripts?.['design:resilience']).toContain('--fail-on-rule soup/scroll-owner-required');
  });

  it('reports text, scroll, geometry, hover, viewport, and layer risks in report-only mode', () => {
    const root = makeFixture(`
export function Fixture() {
  const narrow = window.innerWidth < 768
  return (
    <section>
      <div className="truncate text-t1">long id</div>
      <div className="flex-1 overflow-y-auto p-[var(--sp-3)]">log</div>
      <button className="px-[var(--sp-2)] hover:px-[var(--sp-4)]">Action</button>
      <span className="opacity-0 group-hover:opacity-100">Hidden action</span>
      <h1 className="text-[4vw]">Fleet</h1>
      <main className="min-h-screen">Screen</main>
      <div className="fixed z-50">Overlay</div>
    </section>
  )
}
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.mode).toBe('report-only');
    expect(output.by_rule).toMatchObject({
      'soup/layer-owner-required': 1,
      'soup/no-hover-only-content': 1,
      'soup/no-layout-shift-interaction': 1,
      'soup/no-raw-viewport-js': 1,
      'soup/no-static-viewport-height': 1,
      'soup/no-unsafe-truncation': 1,
      'soup/no-vw-font-size': 1,
      'soup/scroll-owner-required': 1,
    });
    expect(output.finding_count).toBe(8);
  });

  it('fails when promoted raw viewport JS has component-local findings', () => {
    const root = makeFixture(`
export function Fixture() {
  const desktop = window.matchMedia('(min-width: 1024px)').matches
  return <div>{desktop ? 'wide' : 'narrow'}</div>
}
`);
    const result = runScript(root, promotedRuleArgs());
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.failed_rules).toEqual(['soup/no-raw-viewport-js']);
    expect(output.by_rule).toEqual({ 'soup/no-raw-viewport-js': 1 });
  });

  it('allows raw viewport reads only in sanctioned viewport-owner hooks', () => {
    const root = makeFixture(`
export function useViewportPlacement() {
  return {
    rightEdge: window.innerWidth,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}
`, 'console/src/hooks/useViewportPlacement.ts');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.finding_count).toBe(0);
  });

  it('pins the real-source raw viewport JS inventory to zero', () => {
    const result = runScript(process.cwd());
    const output = parsedOutput(result);
    const viewportFindings = output.findings.filter((f) => f.rule === 'soup/no-raw-viewport-js');

    expect(result.status).toBe(0);
    expect(output.by_rule['soup/no-raw-viewport-js']).toBeUndefined();
    expect(viewportFindings).toEqual([]);
  });

  it('fails when a promoted layer-owner rule has findings', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <section>
      <div className="fixed z-50">Overlay</div>
    </section>
  )
}
`);
    const result = runScript(root, promotedRuleArgs());
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(PROMOTED_RULES);
    expect(output.failed_rules).toEqual(['soup/layer-owner-required']);
    expect(output.by_rule).toEqual({ 'soup/layer-owner-required': 1 });
  });

  it('fails when a promoted truncation rule has findings', () => {
    const root = makeFixture(`
export function Fixture() {
  return <div className="truncate text-t1">long id</div>
}
`);
    const result = runScript(root, promotedRuleArgs());
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(PROMOTED_RULES);
    expect(output.failed_rules).toEqual(['soup/no-unsafe-truncation']);
    expect(output.by_rule).toEqual({ 'soup/no-unsafe-truncation': 1 });
  });

  it('fails when a promoted scroll-owner rule has findings', () => {
    const root = makeFixture(`
export function Fixture() {
  return <div className="flex-1 overflow-y-auto p-[var(--sp-3)]">log</div>
}
`);
    const result = runScript(root, promotedRuleArgs());
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(PROMOTED_RULES);
    expect(output.failed_rules).toEqual(['soup/scroll-owner-required']);
    expect(output.by_rule).toEqual({ 'soup/scroll-owner-required': 1 });
  });

  it('fails when promoted interaction and viewport-type rules have findings', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <section>
      <button className="px-[var(--sp-2)] hover:px-[var(--sp-4)]">Action</button>
      <span className="opacity-0 group-hover:opacity-100">Hidden action</span>
      <h1 className="text-[4vw]">Fleet</h1>
      <main className="min-h-screen">Screen</main>
    </section>
  )
}
`);
    const result = runScript(root, promotedRuleArgs());
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(PROMOTED_RULES);
    expect(output.failed_rules).toEqual([
      'soup/no-hover-only-content',
      'soup/no-layout-shift-interaction',
      'soup/no-static-viewport-height',
      'soup/no-vw-font-size',
    ]);
    expect(output.by_rule).toEqual({
      'soup/no-hover-only-content': 1,
      'soup/no-layout-shift-interaction': 1,
      'soup/no-static-viewport-height': 1,
      'soup/no-vw-font-size': 1,
    });
  });

  it('stays silent for documented full-value, scroll-owner, stable-state, focus-parity, type-scale, dynamic-viewport, and layer-token patterns', () => {
    const root = makeFixture(`
export function Fixture({ name }: { name: string }) {
  return (
    <section>
      <div title={name} className="truncate text-t1">{name}</div>
      <div data-full-value={name} className="truncate text-t1">{name}</div>
      <div className="flex-1 min-h-0 overflow-y-auto p-[var(--sp-3)]">log</div>
      <div className="flex-1 min-h-0 min-w-0 overflow-auto p-[var(--sp-3)]">both axes</div>
      <button className="px-[var(--sp-2)] hover:bg-[var(--surface-inset)] focus-visible:outline-none">Action</button>
      <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">Hidden action</span>
      <h1 className="text-t1">Fleet</h1>
      <main className="min-h-dvh">Screen</main>
      <div className="fixed z-[var(--z-float)]">Overlay</div>
    </section>
  )
}
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.finding_count).toBe(0);
    expect(output.scanned_file_count).toBe(1);
  });

  it('requires both min axes for overflow-auto scroll owners', () => {
    const root = makeFixture(`
export function Fixture() {
  return <div className="flex-1 min-h-0 overflow-auto p-[var(--sp-3)]">both axes</div>
}
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule).toEqual({ 'soup/scroll-owner-required': 1 });
  });

  it('flags static viewport-height units and Tailwind screen-height shorthands', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <section>
      <div className="min-h-screen">screen</div>
      <div className="max-h-[85vh]">modal</div>
    </section>
  )
}
`);
    const cssPath = join(root, 'console/src/fixture.css');
    writeFileSync(cssPath, `
.panel { height: calc(100vh - var(--sp-4)); }
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule).toEqual({ 'soup/no-static-viewport-height': 3 });
  });

  it('stays silent for dynamic viewport-height units', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <section>
      <div className="min-h-dvh">screen</div>
      <div className="max-h-[85dvh]">modal</div>
    </section>
  )
}
`);
    const cssPath = join(root, 'console/src/fixture.css');
    writeFileSync(cssPath, `
.panel { height: calc(100dvh - var(--sp-4)); }
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.finding_count).toBe(0);
  });

  it('flags raw CSS outline suppression without a tokenized focus-visible outline replacement', () => {
    const root = makeFixture(`
.bad-row {
  outline: none;
}

.bad-row:focus-visible {
  box-shadow: inset 0 0 0 var(--bw-focus) var(--focus-ring);
}
`, 'console/src/fixture.css');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule).toEqual({ 'soup/no-raw-css-focus-suppression': 1 });
  });

  it('stays silent for raw CSS suppression paired with a tokenized focus-visible outline', () => {
    const root = makeFixture(`
.good-row {
  outline: 0;
}

.good-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: var(--bw-focus);
}
`, 'console/src/fixture.css');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.finding_count).toBe(0);
  });

  it('requires every selector in a grouped CSS reset to have the focus-visible outline replacement', () => {
    const root = makeFixture(`
input,
button {
  outline: none;
}

input:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: var(--bw-focus);
}
`, 'console/src/fixture.css');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule).toEqual({ 'soup/no-raw-css-focus-suppression': 1 });
  });

  it('pins the real-source raw CSS focus suppression inventory to zero findings', () => {
    const result = runScript(process.cwd());
    const output = parsedOutput(result);
    const findings = output.findings.filter((f) => f.rule === 'soup/no-raw-css-focus-suppression');

    expect(result.status).toBe(0);
    expect(output.by_rule['soup/no-raw-css-focus-suppression']).toBeUndefined();
    expect(findings).toEqual([]);
  });

  it('pins the real-source static viewport-height inventory to zero', () => {
    const result = runScript(process.cwd());
    const output = parsedOutput(result);
    const findings = output.findings.filter((f) => f.rule === 'soup/no-static-viewport-height');

    expect(result.status).toBe(0);
    expect(output.by_rule['soup/no-static-viewport-height']).toBeUndefined();
    expect(findings).toEqual([]);
  });

  it('can fail when findings are promoted from report-only to blocking mode', () => {
    const root = makeFixture(`
export function Fixture() {
  return <div className="truncate">id</div>
}
`);
    const result = runScript(root, ['--fail-on-findings']);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-findings');
    expect(output.by_rule).toEqual({ 'soup/no-unsafe-truncation': 1 });
  });

  it('does not treat generic aria-describedby as a proven full-value disclosure path', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <div>
      <div aria-describedby="field-helper" className="truncate">clipped model id</div>
      <p id="field-helper">Choose a model preset or enter a custom value.</p>
    </div>
  )
}
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule).toEqual({ 'soup/no-unsafe-truncation': 1 });
  });

  it('flags interaction-state margin, grid, and border-width geometry changes', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <section>
      <button className="mt-[var(--sp-1)] hover:mt-[var(--sp-3)]">Move</button>
      <button className="border border-transparent focus-visible:border-2">Grow</button>
      <div className="grid grid-cols-2 active:grid-cols-3">Columns</div>
    </section>
  )
}
`);
    const cssPath = join(root, 'console/src/fixture.css');
    writeFileSync(cssPath, `
.card:hover { margin-left: var(--sp-2); }
.card:active { grid-template-columns: 1fr 2fr; }
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule['soup/no-layout-shift-interaction']).toBe(5);
  });

  it('supports repeated scan directories for focused inventories', () => {
    const root = makeFixture('<div className="truncate">src</div>');
    const other = join(root, 'console/tests/Fixture.tsx');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, '<div className="truncate">tests</div>');
    const result = spawnSync(
      'node',
      [
        SCRIPT,
        '--root',
        root,
        '--scan-dir',
        'console/src',
        '--scan-dir',
        'console/tests',
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.finding_count).toBe(2);
    expect(output.scanned_file_count).toBe(2);
  });

  it('fails closed on an empty scan (zero files = broken glob, never a silent PASS)', () => {
    const root = tmp.make('design-resilience-empty');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.scanned_file_count).toBe(0);
    expect(output.verdict).toBe('FAIL');
  });

  it('flags arbitrary z-[N] layer values (regression: trailing \\b previously missed the bracket form)', () => {
    // z-[110] ends in `]` (a non-word char), so the old trailing-\b anchor never
    // matched it — only the bare `z-50` form was caught. This pins the bracket form.
    const root = makeFixture(`
export function Fixture() {
  return <div className="fixed z-[110]">toast</div>
}
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule['soup/layer-owner-required']).toBe(1);
    expect(output.findings.some((f) => f.rule === 'soup/layer-owner-required')).toBe(true);
  });

  it('stays silent for tokenized z-[var(--z-*)] layer values', () => {
    const root = makeFixture(`
export function Fixture() {
  return <div className="fixed z-[var(--z-toast)]">toast</div>
}
`);
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule['soup/layer-owner-required']).toBeUndefined();
    expect(output.finding_count).toBe(0);
  });

  it('H4: flags raw viewport reads in a non-sanctioned file like useBreakpointDebug.tsx', () => {
    // A file named useBreakpointDebug is NOT a sanctioned owner (the old regex /use(?:Breakpoint|ViewportPlacement)\.tsx?$/ would
    // have exempted it because "useBreakpointDebug" contains "useBreakpoint" as a prefix, but
    // the pinned exact-path guard must reject it).
    const root = makeFixture(`
export function useBreakpointDebug() {
  return { width: window.innerWidth }
}
`, 'console/src/hooks/useBreakpointDebug.tsx');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule['soup/no-raw-viewport-js']).toBe(1);
    expect(output.findings.some((f) => f.rule === 'soup/no-raw-viewport-js')).toBe(true);
  });

  it('H4: stays silent for the exact sanctioned useViewportPlacement.ts owner path', () => {
    const root = makeFixture(`
export function useViewportPlacement() {
  return { rightEdge: window.innerWidth }
}
`, 'console/src/hooks/useViewportPlacement.ts');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule['soup/no-raw-viewport-js']).toBeUndefined();
    expect(output.finding_count).toBe(0);
  });

  it('H4: stays silent for the exact sanctioned useBreakpoint.ts owner path', () => {
    const root = makeFixture(`
export function useBreakpoint() {
  return { md: matchMedia('(min-width: 768px)').matches }
}
`, 'console/src/hooks/useBreakpoint.ts');
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(output.by_rule['soup/no-raw-viewport-js']).toBeUndefined();
    expect(output.finding_count).toBe(0);
  });
});
