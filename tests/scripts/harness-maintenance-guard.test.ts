import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS,
  npmCooldownConfigCheck,
  npmVersionAge,
  run,
  validateManifestPayload,
} from '../../scripts/harness-maintenance-guard.ts';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    npm: {
      cooldown_minutes: DEFAULT_COOLDOWN_MINUTES,
      npmrc_min_release_age_days: DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS,
      npmrc: 'deploy/npmrc.hardened',
      codex_node: {
        node_bin: '$HOME/.nvm/versions/node/v24.13.0/bin',
        npm_min_version: '11.12.0',
      },
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
    expect(result.npmrcMinReleaseAgeDays).toBe(DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS);
    expect(result.codexNodeNpmMinVersion).toBe('11.12.0');
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

  it('rejects npmrc min-release-age values below seven days', () => {
    const bad = manifest({
      npm: {
        cooldown_minutes: DEFAULT_COOLDOWN_MINUTES,
        npmrc_min_release_age_days: 1,
      },
    });
    expect(() => validateManifestPayload(bad)).toThrow(
      `npm.npmrc_min_release_age_days must be at least ${DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS}`,
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

  it('marks codex npm cooldown config as ok when npm recognizes min-release-age', () => {
    const result = npmCooldownConfigCheck({
      npmVersion: '11.12.1',
      minVersion: '11.12.0',
      expectedDays: '7',
      npmrcText: 'registry=https://registry.npmjs.org/\nmin-release-age=7\naudit=true\n',
      installExitCode: 0,
      stderr: '',
    });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('marks codex npm cooldown config as degraded when npm warns the key is unknown', () => {
    const result = npmCooldownConfigCheck({
      npmVersion: '11.8.0',
      minVersion: '11.12.0',
      expectedDays: '7',
      npmrcText: 'min-release-age=7\n',
      installExitCode: 0,
      stderr:
        'npm warn Unknown user config "min-release-age". This will stop working in the next major version of npm.\n',
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('npm 11.8.0 is below required 11.12.0');
    expect(result.reasons).toContain('npm does not recognize min-release-age');
  });

  it('marks codex npm cooldown config as degraded when npmrc uses minute units', () => {
    const result = npmCooldownConfigCheck({
      npmVersion: '11.12.1',
      minVersion: '11.12.0',
      expectedDays: '7',
      npmrcText: 'min-release-age=10080\n',
      installExitCode: 1,
      stderr: '',
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      'npmrc min-release-age is 10080, expected 7',
      'npm dry-run install failed with min-release-age enabled',
    ]);
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
