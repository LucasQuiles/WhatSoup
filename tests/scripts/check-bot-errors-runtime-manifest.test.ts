import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkBotErrorsRuntimeManifest,
  computeRequiredRuntimePaths,
  REQUIRED_RUNTIME_MANIFEST_PATHS,
  run,
} from '../../scripts/check-bot-errors-runtime-manifest.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-runtime-manifest-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'deploy'), { recursive: true });
  return root;
}

function writeManifest(root: string, files: unknown[]): void {
  writeFileSync(
    path.join(root, 'deploy', 'bot-errors-runtime-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`,
    'utf8',
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-bot-errors-runtime-manifest guard', () => {
  it('requires the runtime health signal registry as an integrity-pinned dependency', () => {
    expect(computeRequiredRuntimePaths(repoRoot))
      .toContain('src/lib/fault-taxonomy-registry.json');
  });

  it('keeps the checked-in BOT ERRORS runtime manifest aligned with scripts and markers', () => {
    const result = checkBotErrorsRuntimeManifest(repoRoot);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(computeRequiredRuntimePaths(repoRoot).length);
  });

  it('globs deploy/scripts python so a NEW unpinned, unsuppressed script fails closed (L6-06)', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'deploy', 'scripts', 'newcomer.py'), 'print("new")\n', 'utf8');
    writeManifest(root, []);

    const result = checkBotErrorsRuntimeManifest(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'missing-required-path', path: 'deploy/scripts/newcomer.py' }),
    );
  });

  it('does NOT require a suppressed operator-CLI script to be pinned (L6-06 suppress-list)', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'deploy', 'scripts', 'bot-errors-maintenance.py'), 'print("cli")\n', 'utf8');
    writeManifest(root, []);

    const result = checkBotErrorsRuntimeManifest(root);

    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ code: 'missing-required-path', path: 'deploy/scripts/bot-errors-maintenance.py' }),
    );
  });

  it('fails closed when a manifest file hash drifts', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'deploy', 'scripts', 'probe.py'), 'actual\n', 'utf8');
    writeManifest(root, [
      {
        path: 'deploy/scripts/probe.py',
        sha256: sha256('expected\n'),
      },
    ]);

    const result = checkBotErrorsRuntimeManifest(root, 'deploy/bot-errors-runtime-manifest.json', ['deploy/scripts/probe.py']);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'hash-drift', path: 'deploy/scripts/probe.py' }),
    ]);
  });

  it('fails closed when a required marker is missing', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    const body = 'actual capability\n';
    writeFileSync(path.join(root, 'deploy', 'scripts', 'probe.py'), body, 'utf8');
    writeManifest(root, [
      {
        path: 'deploy/scripts/probe.py',
        sha256: sha256(body),
        mustContain: ['required-capability-marker'],
      },
    ]);

    const result = checkBotErrorsRuntimeManifest(root, 'deploy/bot-errors-runtime-manifest.json', ['deploy/scripts/probe.py']);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'missing-marker', path: 'deploy/scripts/probe.py' }),
    ]);
  });

  it('rejects unsafe manifest paths before reading files', () => {
    const root = makeRoot();
    writeManifest(root, [
      {
        path: '../outside.py',
        sha256: '0'.repeat(64),
      },
    ]);

    const result = checkBotErrorsRuntimeManifest(root, 'deploy/bot-errors-runtime-manifest.json', []);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'unsafe-path', path: '../outside.py' }),
    ]);
  });

  it('reports duplicate manifest paths as findings', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    const body = 'same\n';
    writeFileSync(path.join(root, 'deploy', 'scripts', 'probe.py'), body, 'utf8');
    writeManifest(root, [
      { path: 'deploy/scripts/probe.py', sha256: sha256(body) },
      { path: 'deploy/scripts/probe.py', sha256: sha256(body) },
    ]);

    const result = checkBotErrorsRuntimeManifest(root, 'deploy/bot-errors-runtime-manifest.json', ['deploy/scripts/probe.py']);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'duplicate-path', path: 'deploy/scripts/probe.py' }),
    ]);
  });

  it('CLI run exits nonzero and prints actionable findings on drift', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'deploy', 'scripts', 'probe.py'), 'actual\n', 'utf8');
    writeManifest(root, [
      {
        path: 'deploy/scripts/probe.py',
        sha256: sha256('expected\n'),
      },
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run([], root);

    expect(result.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('hash-drift');
  });

  it('fails closed when a required BOT ERRORS runtime file is omitted from the manifest', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
    const body = 'same\n';
    writeFileSync(path.join(root, 'deploy', 'scripts', 'present.py'), body, 'utf8');
    writeFileSync(path.join(root, 'deploy', 'scripts', 'missing.py'), body, 'utf8');
    writeManifest(root, [
      { path: 'deploy/scripts/present.py', sha256: sha256(body) },
    ]);

    const result = checkBotErrorsRuntimeManifest(root, 'deploy/bot-errors-runtime-manifest.json', [
      'deploy/scripts/present.py',
      'deploy/scripts/missing.py',
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'missing-required-path', path: 'deploy/scripts/missing.py' }),
    ]);
  });
});
