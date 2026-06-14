import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-design-resilience.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function makeFixture(source: string, filePath = 'console/src/Fixture.tsx') {
  const root = mkdtempSync(join(tmpdir(), 'design-resilience-'));
  tmpDirs.push(root);
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

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    by_rule: Record<string, number>;
    finding_count: number;
    findings: Array<{ rule: string; file: string; line: number }>;
    mode: 'report-only' | 'fail-on-findings';
    scanned_file_count: number;
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-design-resilience.mjs', () => {
  it('reports text, scroll, geometry, hover, viewport-font, and layer risks in report-only mode', () => {
    const root = makeFixture(`
export function Fixture() {
  return (
    <section>
      <div className="truncate text-t1">long id</div>
      <div className="flex-1 overflow-y-auto p-[var(--sp-3)]">log</div>
      <button className="px-[var(--sp-2)] hover:px-[var(--sp-4)]">Action</button>
      <span className="opacity-0 group-hover:opacity-100">Hidden action</span>
      <h1 className="text-[4vw]">Fleet</h1>
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
      'soup/no-unsafe-truncation': 1,
      'soup/no-vw-font-size': 1,
      'soup/scroll-owner-required': 1,
    });
    expect(output.finding_count).toBe(6);
  });

  it('stays silent for documented full-value, scroll-owner, stable-state, focus-parity, type-scale, and layer-token patterns', () => {
    const root = makeFixture(`
export function Fixture({ name }: { name: string }) {
  return (
    <section>
      <div title={name} className="truncate text-t1">{name}</div>
      <div className="flex-1 min-h-0 overflow-y-auto p-[var(--sp-3)]">log</div>
      <button className="px-[var(--sp-2)] hover:bg-[var(--surface-inset)] focus-visible:outline-none">Action</button>
      <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">Hidden action</span>
      <h1 className="text-t1">Fleet</h1>
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
    const root = mkdtempSync(join(tmpdir(), 'design-resilience-empty-'));
    tmpDirs.push(root);
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
});
