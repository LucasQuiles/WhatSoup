import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_COOLDOWN_MINUTES,
  npmVersionAge,
  run,
  validateManifestPayload,
} from '../../scripts/harness-maintenance-guard.ts';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    npm: {
      cooldown_minutes: DEFAULT_COOLDOWN_MINUTES,
      npmrc: 'deploy/npmrc.hardened',
    },
    tier1: [
      {
        name: 'claude',
        kind: 'native',
        smoke: ['claude', '--version'],
      },
      {
        name: 'codex',
        kind: 'npm-global',
        package: '@openai/codex',
        smoke: ['codex', '--version'],
      },
      {
        name: 'opencode',
        kind: 'native',
        smoke: ['opencode', '--version'],
      },
    ],
    tier2: {
      probes: [
        {
          name: 'mcp-servers',
          mode: 'detect-only',
          commands: ['claude mcp list', 'npx @playwright/mcp@latest'],
        },
      ],
    },
    ...overrides,
  };
}

describe('harness maintenance guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('validates the required tier1 harnesses and probes', () => {
    const result = validateManifestPayload(manifest());
    expect(result.schemaVersion).toBe(1);
    expect(result.cooldownMinutes).toBe(DEFAULT_COOLDOWN_MINUTES);
    expect(result.tier1Harnesses).toEqual(['claude', 'codex', 'opencode']);
    expect(result.probes).toEqual(['mcp-servers']);
  });

  it('rejects manifests that omit a required harness', () => {
    const bad = manifest({
      tier1: [
        { name: 'claude', kind: 'native', smoke: ['claude', '--version'] },
        { name: 'codex', kind: 'npm-global', smoke: ['codex', '--version'] },
      ],
    });
    expect(() => validateManifestPayload(bad)).toThrow('tier1 must include opencode');
  });

  it('rejects cooldown values below seven days', () => {
    const bad = manifest({ npm: { cooldown_minutes: 60 } });
    expect(() => validateManifestPayload(bad)).toThrow(
      `npm.cooldown_minutes must be at least ${DEFAULT_COOLDOWN_MINUTES}`,
    );
  });

  it('reports floating latest references without failing validation', () => {
    const result = validateManifestPayload(manifest());
    expect(result.floatingReferences).toEqual([
      {
        path: 'tier2.probes[0].commands[1]',
        value: 'npx @playwright/mcp@latest',
      },
    ]);
    expect(result.warnings[0]).toContain('floating latest reference');
  });

  it('marks npm versions older than the cooldown as eligible', () => {
    const now = new Date('2026-05-29T12:00:00Z');
    const result = npmVersionAge(
      { '0.135.0': '2026-05-20T11:59:00Z' },
      '0.135.0',
      now,
      DEFAULT_COOLDOWN_MINUTES,
    );
    expect(result.eligible).toBe(true);
    expect(result.ageMinutes).toBeGreaterThan(DEFAULT_COOLDOWN_MINUTES);
  });

  it('holds npm versions younger than the cooldown', () => {
    const now = new Date('2026-05-29T12:00:00Z');
    const result = npmVersionAge(
      { '0.135.1': '2026-05-28T12:00:00Z' },
      '0.135.1',
      now,
      DEFAULT_COOLDOWN_MINUTES,
    );
    expect(result.eligible).toBe(false);
    expect(result.ageMinutes).toBe(24 * 60);
  });

  it('run() returns exit code 2 for held npm versions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-harness-'));
    const timeJson = path.join(dir, 'time.json');
    writeFileSync(
      timeJson,
      JSON.stringify({ '0.135.1': '2026-05-28T12:00:00Z' }),
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = run([
      '--version-eligible',
      '0.135.1',
      '--time-json',
      timeJson,
      '--now',
      '2026-05-29T12:00:00Z',
    ]);

    expect((result as { eligible: boolean }).eligible).toBe(false);
    expect(process.exitCode).toBe(2);
  });
});
