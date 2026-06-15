import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findNodePinDrift,
  run,
} from '../../scripts/check-node-pin-consistency.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Build a minimal repo fixture with the four pin surfaces (nvmrc, package.json,
 * Dockerfile, three wrappers). Each surface defaults to the canonical version
 * unless an override is provided.
 */
function makeFixture(opts: {
  nvmrc?: string;
  voltaNode?: string;
  enginesNode?: string;
  dockerVersion?: string;
  wrapperVersion?: string | 'reads-nvmrc' | 'none';
  wrappers?: (
    | 'deploy/whatsoup'
    | 'deploy/whatsoup-auth'
    | 'deploy/whatsoup-fleet'
    | 'scripts/run-with-pinned-node.sh'
    | 'scripts/run-with-pinned-npm.sh'
  )[];
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-node-pin-'));
  const nvmrc = opts.nvmrc ?? '24.15.0';
  const voltaNode = opts.voltaNode ?? '24.15.0';
  const enginesNode = opts.enginesNode ?? '>=24.0.0 <26';
  const dockerVersion = opts.dockerVersion ?? '24.15.0';
  const wrapperVersion = opts.wrapperVersion ?? 'reads-nvmrc';
  const wrappers = opts.wrappers ?? [
    'deploy/whatsoup',
    'deploy/whatsoup-auth',
    'deploy/whatsoup-fleet',
    'scripts/run-with-pinned-node.sh',
    'scripts/run-with-pinned-npm.sh',
  ];

  writeFileSync(path.join(dir, '.nvmrc'), `${nvmrc}\n`, 'utf8');
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        engines: { node: enginesNode },
        volta: { node: voltaNode },
      },
      null,
      2,
    ),
    'utf8',
  );

  mkdirSync(path.join(dir, 'docker'), { recursive: true });
  writeFileSync(
    path.join(dir, 'docker/Dockerfile'),
    `FROM node:${dockerVersion}-slim AS deps\nFROM node:${dockerVersion}-slim AS runtime\n`,
    'utf8',
  );

  for (const wrapperPath of wrappers) {
    mkdirSync(path.dirname(path.join(dir, wrapperPath)), { recursive: true });
    let body = '#!/usr/bin/env bash\nset -euo pipefail\n';
    if (wrapperVersion === 'reads-nvmrc') {
      body += 'REPO_ROOT="$(pwd)"\nNODE_VERSION="$(cat "$REPO_ROOT/.nvmrc")"\n';
    } else if (wrapperVersion === 'none') {
      body += 'NODE="$(command -v node)"\n';
    } else {
      body += `DEFAULT_NODE="$HOME/.nvm/versions/node/v${wrapperVersion}/bin/node"\n`;
    }
    writeFileSync(path.join(dir, wrapperPath), body, 'utf8');
  }
  return dir;
}

describe('node-pin consistency check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes on the real repo with all surfaces aligned', () => {
    const drift = findNodePinDrift({ cwd: repoRoot });
    expect(drift.canonical).toMatch(/^\d+\.\d+\.\d+$/);
    expect(drift.mismatches).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it('passes on a happy-path fixture where wrappers read .nvmrc', () => {
    const dir = makeFixture({});
    const drift = findNodePinDrift({ cwd: dir });
    expect(drift.canonical).toBe('24.15.0');
    expect(drift.mismatches).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it('flags wrappers that hardcode a stale Node version path', () => {
    const dir = makeFixture({ wrapperVersion: '24.13.0' });
    const drift = findNodePinDrift({ cwd: dir });
    expect(drift.canonical).toBe('24.15.0');
    expect(drift.mismatches).toHaveLength(5);
    for (const m of drift.mismatches) {
      expect(m.version).toBe('24.13.0');
      expect([
        'deploy/whatsoup',
        'deploy/whatsoup-auth',
        'deploy/whatsoup-fleet',
        'scripts/run-with-pinned-node.sh',
        'scripts/run-with-pinned-npm.sh',
      ]).toContain(m.source);
    }
  });

  it('flags a Dockerfile pinned to a non-canonical version', () => {
    const dir = makeFixture({ dockerVersion: '24.14.0' });
    const drift = findNodePinDrift({ cwd: dir });
    const dockerMismatches = drift.mismatches.filter(
      (m) => m.source === 'docker/Dockerfile',
    );
    expect(dockerMismatches.length).toBeGreaterThan(0);
    for (const m of dockerMismatches) {
      expect(m.version).toBe('24.14.0');
    }
  });

  it('flags a volta.node pinned to a non-canonical version', () => {
    const dir = makeFixture({ voltaNode: '24.10.0' });
    const drift = findNodePinDrift({ cwd: dir });
    const voltaMismatch = drift.mismatches.find(
      (m) => m.source === 'package.json#volta.node',
    );
    expect(voltaMismatch).toBeDefined();
    expect(voltaMismatch?.version).toBe('24.10.0');
  });

  it('reports a missing volta.node as a structural problem, not a mismatch', () => {
    const dir = makeFixture({ voltaNode: '' });
    // Manually rewrite package.json to omit volta entirely.
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', engines: { node: '>=24.0.0 <26' } }, null, 2),
      'utf8',
    );
    const drift = findNodePinDrift({ cwd: dir });
    const voltaMissing = drift.missing.find(
      (m) => m.source === 'package.json#volta.node',
    );
    expect(voltaMissing).toEqual({
      source: 'package.json#volta.node',
      filePath: path.join(dir, 'package.json'),
      reason: 'volta.node not set',
    });
    // Mismatches list must not double-count a missing pin.
    expect(
      drift.mismatches.find((m) => m.source === 'package.json#volta.node'),
    ).toBeUndefined();
  });

  it('run() exits non-zero and prints diagnostics when drift is present', () => {
    const dir = makeFixture({ wrapperVersion: '24.13.0' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const drift = run([], dir, {});

    expect(process.exitCode).toBe(1);
    expect(drift.mismatches.length).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalled();
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('Canonical Node version');
    expect(printed).toContain('24.13.0');
  });

  it('run() honors the WHATSOUP_SKIP_NODE_PIN_CHECK escape hatch locally', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Point at a drift-laden fixture; the escape hatch must short-circuit
    // before any file reads happen, returning the empty-skip sentinel.
    const dir = makeFixture({ wrapperVersion: '24.13.0' });
    const drift = run([], dir, { WHATSOUP_SKIP_NODE_PIN_CHECK: '1' });
    expect(drift).toEqual({ canonical: '', mismatches: [], missing: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      'node-pin consistency check skipped via WHATSOUP_SKIP_NODE_PIN_CHECK=1',
    );
    // Skip path must not flip the CLI exit code from undefined to a failing value,
    // even though the underlying fixture is intentionally drift-laden.
    expect(process.exitCode).not.toBe(1);
    expect(process.exitCode).toBe(undefined);
  });

  it('run() ignores WHATSOUP_SKIP_NODE_PIN_CHECK in CI and still reports drift', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = makeFixture({ wrapperVersion: '24.13.0' });

    const drift = run([], dir, { WHATSOUP_SKIP_NODE_PIN_CHECK: '1', CI: 'true' });

    expect(drift.mismatches.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'WHATSOUP_SKIP_NODE_PIN_CHECK=1 ignored: CI/GITHUB_ACTIONS detected; node-pin consistency check will run (this skip is for local dev only)',
    );
  });

  it('run() ignores WHATSOUP_SKIP_NODE_PIN_CHECK in GitHub Actions and still reports drift', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = makeFixture({ wrapperVersion: '24.13.0' });

    const drift = run([], dir, { WHATSOUP_SKIP_NODE_PIN_CHECK: '1', GITHUB_ACTIONS: 'true' });

    expect(drift.mismatches.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'WHATSOUP_SKIP_NODE_PIN_CHECK=1 ignored: CI/GITHUB_ACTIONS detected; node-pin consistency check will run (this skip is for local dev only)',
    );
  });
});
