import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-waiver-sync.mjs');

const tmp = trackTmpDirs('check-waiver-');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const COMPLETE_WAIVER = `waivers:
  - id: WVR-001
    rule: react-hooks/exhaustive-deps
    owner: console-maintainer
    reason: intentional mount-only effect.
    scope: console/src/Fixture.tsx
    expiry: 2099-12-31
    replacement_plan: re-express with useRef-guarded init.
    safer_alternative_considered: adding deps — rejected, would re-seed state.
    status: temporary
    expiration_phase: C3
    cleanup_trigger: wizard migration slice
    user_approval_required: no
`;

/**
 * Build a minimal fixture tree under a temp dir and return the console root.
 * opts.source  — content of console/src/Fixture.tsx
 * opts.waivers — content of console/eslint-waivers.yaml
 */
function makeFixture(opts: {
  source?: string;
  waivers?: string;
} = {}) {
  const root = tmp.make('sync');

  const consoleDir = join(root, 'console');
  const srcDir = join(consoleDir, 'src');
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    join(srcDir, 'Fixture.tsx'),
    opts.source ??
      `/* eslint-disable react-hooks/exhaustive-deps -- waiver:WVR-001 test fixture; expires 2099-12-31 */\nexport const Fixture = 1;\n`,
  );
  writeFileSync(
    join(consoleDir, 'eslint-waivers.yaml'),
    opts.waivers ?? COMPLETE_WAIVER,
  );

  return consoleDir;
}

function runWaiverSync(consoleRoot: string) {
  return spawnSync('node', [SCRIPT, '--console-root', consoleRoot], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

interface WaiverSyncOutput {
  verdict: 'PASS' | 'FAIL';
  issue_count: number;
  registered_count: number;
  source_tag_count: number;
  untagged_count: number;
  untagged_suppressions: Array<{ file: string; line: number; evidence: string }>;
  unknown_source_ids: string[];
  stale_registry_scope_count: number;
  stale_registry_scopes: Array<{ id: string; scope_file: string }>;
  schema_violation_count: number;
  schema_violations: Array<{ id: string; field: string }>;
  bypass_violation_count: number;
  bypass_violations: Array<{ file: string; line: number; evidence: string; bypass_attrs: string[] }>;
}

function parsedOutput(result: ReturnType<typeof runWaiverSync>): WaiverSyncOutput {
  return JSON.parse(result.stdout) as WaiverSyncOutput;
}

// ---------------------------------------------------------------------------
// M2: waiver schema completeness
// ---------------------------------------------------------------------------

describe('check-waiver-sync.mjs — M2 schema completeness', () => {
  it('passes when all 12 required fields are present in every waiver', () => {
    const consoleRoot = makeFixture({ waivers: COMPLETE_WAIVER });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.schema_violation_count).toBe(0);
    expect(output.schema_violations).toEqual([]);
  });

  it('fails when a waiver entry is missing expiration_phase', () => {
    const incompleteWaiver = COMPLETE_WAIVER.replace('\n    expiration_phase: C3', '');
    const consoleRoot = makeFixture({ waivers: incompleteWaiver });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.schema_violation_count).toBeGreaterThan(0);
    expect(output.schema_violations).toContainEqual({ id: 'WVR-001', field: 'expiration_phase' });
  });

  it('fails when a waiver entry is missing cleanup_trigger', () => {
    const incompleteWaiver = COMPLETE_WAIVER.replace('\n    cleanup_trigger: wizard migration slice', '');
    const consoleRoot = makeFixture({ waivers: incompleteWaiver });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.schema_violations).toContainEqual({ id: 'WVR-001', field: 'cleanup_trigger' });
  });

  it('fails when a waiver entry is missing user_approval_required', () => {
    const incompleteWaiver = COMPLETE_WAIVER.replace('\n    user_approval_required: no', '');
    const consoleRoot = makeFixture({ waivers: incompleteWaiver });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.schema_violations).toContainEqual({ id: 'WVR-001', field: 'user_approval_required' });
  });

  it('names the offending WVR id and field in schema violations', () => {
    // Strip three fields to prove all are detected together.
    const incompleteWaiver = COMPLETE_WAIVER
      .replace('\n    expiration_phase: C3', '')
      .replace('\n    cleanup_trigger: wizard migration slice', '')
      .replace('\n    user_approval_required: no', '');
    const consoleRoot = makeFixture({ waivers: incompleteWaiver });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.schema_violation_count).toBe(3);
    const fields = output.schema_violations.map((v) => v.field);
    expect(fields).toContain('expiration_phase');
    expect(fields).toContain('cleanup_trigger');
    expect(fields).toContain('user_approval_required');
    // All violations belong to WVR-001.
    expect(output.schema_violations.every((v) => v.id === 'WVR-001')).toBe(true);
  });

  it('schema violations contribute to issue_count and flip verdict to FAIL', () => {
    const incompleteWaiver = COMPLETE_WAIVER.replace('\n    expiration_phase: C3', '');
    const consoleRoot = makeFixture({ waivers: incompleteWaiver });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.issue_count).toBeGreaterThan(0);
    expect(output.verdict).toBe('FAIL');
  });

  it('passes the live registry — WVR-012 fix is present and all entries are schema-complete', () => {
    const result = spawnSync('node', [SCRIPT], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.schema_violation_count).toBe(0);
    expect(output.schema_violations).toEqual([]);
    // Confirm WVR-012 is no longer the violation it was before the fix.
    expect(output.schema_violations.map((v) => v.id)).not.toContain('WVR-012');
  });
});

// ---------------------------------------------------------------------------
// H1: bypass-attribute waiver enforcement
// ---------------------------------------------------------------------------

describe('check-waiver-sync.mjs — H1 bypass-attribute registry enforcement', () => {
  it('fails when soup-layer-ok appears without a waiver annotation', () => {
    const source = `
export function Fixture() {
  return <div className="fixed z-50" soup-layer-ok>Overlay</div>;
}
`;
    const consoleRoot = makeFixture({ source });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.bypass_violation_count).toBeGreaterThan(0);
    expect(output.bypass_violations[0]?.file).toContain('Fixture.tsx');
  });

  it('fails when soup-layer-ok has a waiver annotation referencing an unregistered id', () => {
    const source = `
export function Fixture() {
  return <div className="fixed z-50" soup-layer-ok /* waiver:WVR-999 */>Overlay</div>;
}
`;
    const consoleRoot = makeFixture({ source });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    // WVR-999 is not in the registry so this is an unknown id (bypass violation)
    // or unknown_source_ids — either way the check must fail.
    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
  });

  it('passes when soup-layer-ok has a waiver annotation on the same line matching a registered entry', () => {
    const source = `
export function Fixture() {
  return <div className="fixed z-50" soup-layer-ok /* waiver:WVR-001 layer exception */>Overlay</div>;
}
`;
    const consoleRoot = makeFixture({ source });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.bypass_violation_count).toBe(0);
  });

  it('fails when data-scroll-owner= appears without a waiver annotation', () => {
    const source = `
export function Fixture() {
  return <div className="overflow-y-auto min-h-0" data-scroll-owner="message-list">log</div>;
}
`;
    const consoleRoot = makeFixture({ source });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.bypass_violation_count).toBeGreaterThan(0);
  });

  it('passes when data-scroll-owner= has a waiver annotation on the same line matching a registered entry', () => {
    const source = `
export function Fixture() {
  return <div className="overflow-y-auto min-h-0" data-scroll-owner="message-list" /* waiver:WVR-001 */>log</div>;
}
`;
    const consoleRoot = makeFixture({ source });
    const result = runWaiverSync(consoleRoot);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.bypass_violation_count).toBe(0);
  });

  it('confirms zero bypass-attribute uses in the real console/src tree', () => {
    // This test documents the rg evidence: zero bypass attrs exist today, so
    // the new gate passes clean on the live tree.
    const result = spawnSync('node', [SCRIPT], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.bypass_violation_count).toBe(0);
    expect(output.bypass_violations).toEqual([]);
  });
});
