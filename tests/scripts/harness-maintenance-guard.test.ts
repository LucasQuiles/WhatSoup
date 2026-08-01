import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManifestValidation } from '../../scripts/harness-maintenance-guard.ts';

import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS,
  latestEligibleVersion,
  npmCooldownConfigCheck,
  npmVersionAge,
  run,
  validateManifestText,
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

  it('declares OpenCode as an installable npm-backed harness in the checked-in manifest', () => {
    const source = JSON.parse(
      readFileSync(path.join(process.cwd(), 'deploy/managed-components.json'), 'utf8'),
    ) as { tier1: Array<{ name?: string; kind?: string; package?: string; update?: string[] }> };

    const opencode = source.tier1.find((entry) => entry.name === 'opencode');
    expect(opencode?.kind).toBe('npm-global');
    expect(opencode?.package).toBe('opencode-ai');
    expect(opencode?.update).toContain('opencode-ai@{target}');
  });

  it('validates manifest text and rejects malformed manifest field shapes', () => {
    expect(validateManifestText(JSON.stringify(manifest())).tier1Harnesses).toEqual([
      'claude',
      'codex',
      'opencode',
    ]);

    expect(() => validateManifestPayload(null)).toThrow('manifest must be an object');
    expect(() => validateManifestPayload({ ...manifest(), schema_version: 2 })).toThrow('schema_version must be 1');
    expect(() => validateManifestPayload({ ...manifest(), schema_version: '1' })).toThrow('schema_version must be a number');
    expect(() => validateManifestPayload({ ...manifest(), npm: null })).toThrow('npm must be an object');
    expect(() => validateManifestPayload({
      ...manifest(),
      npm: { ...(manifest().npm as Record<string, unknown>), codex_node: null },
    })).toThrow('npm.codex_node must be an object');
    expect(() => validateManifestPayload({
      ...manifest(),
      npm: {
        ...(manifest().npm as Record<string, unknown>),
        codex_node: { node_bin: '', npm_min_version: '11.12.0' },
      },
    })).toThrow('npm.codex_node.node_bin must be a string');
    expect(() => validateManifestPayload({ ...manifest(), tier1: 'bad' })).toThrow('tier1 must be an array');
    expect(() => validateManifestPayload({
      ...manifest(),
      tier1: [null, { name: 'codex', kind: 'npm-global', smoke: [] }, { name: 'opencode', kind: 'native', smoke: [] }],
    })).toThrow('tier1[0] must be an object');
    expect(() => validateManifestPayload({
      ...manifest(),
      tier1: [{ name: '', kind: 'native', smoke: [] }, { name: 'codex', kind: 'npm-global', smoke: [] }, { name: 'opencode', kind: 'native', smoke: [] }],
    })).toThrow('tier1[0].name must be a string');
    expect(() => validateManifestPayload({
      ...manifest(),
      tier2: { probes: [{ name: 'mcp-servers', mode: '' }] },
    })).toThrow('tier2.probes[0].mode must be a string');
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
    // The fixture mcp-servers probe has an unexpected floating ref
    expect(result.floatingReferences).toEqual([
      {
        path: 'tier2.probes[0].commands[1]',
        value: 'npx @playwright/mcp@latest',
      },
    ]);
    // Unexpected: not in a tier1 update/rollback channel
    expect(result.unexpectedFloatingReferences).toEqual([
      {
        path: 'tier2.probes[0].commands[1]',
        value: 'npx @playwright/mcp@latest',
      },
    ]);
    // No allowed floating refs in this fixture
    expect(result.allowedFloatingReferences).toEqual([]);
    // No warning for allowed refs when there are none
    expect(result.warnings).toEqual([]);
  });

  it('allows floating latest references in tier1 update and rollback channels', () => {
    const withChannels = {
      ...manifest(),
      tier1: [
        {
          name: 'claude',
          kind: 'native',
          update: ['claude', 'install', 'latest'],
          rollback: ['claude', 'install', '{previous}'],
          smoke: ['claude', '--version'],
        },
        { name: 'codex', kind: 'npm-global', package: '@openai/codex', smoke: ['codex', '--version'] },
        { name: 'opencode', kind: 'native', smoke: ['opencode', '--version'] },
      ],
      tier2: { probes: [{ name: 'runtime', mode: 'detect-only' }] },
    };
    const result = validateManifestPayload(withChannels);
    // 'latest' appears in tier1[0].update[2] and tier1[0].rollback is fine (no latest there)
    expect(result.allowedFloatingReferences.length).toBeGreaterThan(0);
    expect(result.unexpectedFloatingReferences).toEqual([]);
    expect(result.warnings[0]).toContain('allowed floating');
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

  it('selects the newest npm version older than the cooldown window', () => {
    const now = new Date('2026-06-12T08:47:00Z');
    const result = latestEligibleVersion(
      {
        '1.15.13': '2026-05-30T23:39:08.179Z',
        '1.16.0': '2026-06-05T03:06:04.474Z',
        '1.16.1': '2026-06-05T15:04:43.007Z',
        '1.17.4': '2026-06-12T02:17:23.837Z',
        modified: '2026-06-12T08:41:55.650Z',
      },
      now,
      DEFAULT_COOLDOWN_MINUTES,
    );

    expect(result.version).toBe('1.16.0');
  });

  it('reports null when no npm version is older than the cooldown window', () => {
    const result = latestEligibleVersion(
      { '1.0.0': '2026-06-12T07:47:00Z' },
      new Date('2026-06-12T08:47:00Z'),
      DEFAULT_COOLDOWN_MINUTES,
    );

    expect(result).toEqual({
      version: null,
      cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    });
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

  it('marks codex npm cooldown config as degraded when min-release-age is missing', () => {
    const result = npmCooldownConfigCheck({
      npmVersion: '11.12.1',
      minVersion: '11.12.0',
      expectedDays: '7',
      npmrcText: '# comments only\n; and semicolon comments\n',
      installExitCode: 0,
      stderr: '',
    });

    expect(result.ok).toBe(false);
    expect(result.npmrcValue).toBeNull();
    expect(result.reasons).toEqual(['npmrc min-release-age is (missing), expected 7']);
  });

  it('rejects missing or invalid npm publish times', () => {
    expect(() => npmVersionAge({}, '0.135.2')).toThrow('no npm publish time');
    expect(() =>
      npmVersionAge({ '0.135.2': 'not-a-date' }, '0.135.2'),
    ).toThrow('invalid npm publish time');
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

  it('run() prints the latest eligible npm version for installer flows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-harness-'));
    const timeJson = path.join(dir, 'time.json');
    writeFileSync(
      timeJson,
      JSON.stringify({
        '1.15.13': '2026-05-30T23:39:08.179Z',
        '1.16.0': '2026-06-05T03:06:04.474Z',
        '1.17.4': '2026-06-12T02:17:23.837Z',
      }),
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = run([
        '--latest-eligible-version',
        '--time-json',
        timeJson,
        '--now',
        '2026-06-12T08:47:00Z',
      ]);

      expect((result as { version: string | null }).version).toBe('1.16.0');
      expect(log.mock.calls.flat().join('\n')).toContain('1.16.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run() prints JSON and plain output for manifest validation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-harness-'));
    const manifestPath = path.join(dir, 'managed-components.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest()), 'utf8');

      const jsonResult = run(['--manifest', manifestPath, '--json']);
      // fixture has an unexpected floating ref — exits with code 2
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;

      const plainResult = run(['--manifest', manifestPath]);

      expect((jsonResult as ManifestValidation).schemaVersion).toBe(1);
      expect((plainResult as ManifestValidation).probes).toEqual(['mcp-servers']);
      expect(JSON.parse(String(log.mock.calls[0][0])).schemaVersion).toBe(1);
      expect(log.mock.calls.flat().join('\n')).toContain('harness-maintenance manifest ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run() exits 2 for unexpected floating latest references', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-harness-'));
    const manifestPath = path.join(dir, 'managed-components.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // unexpected floating ref in a non-update-channel location
      const badManifest = {
        ...manifest(),
        tier2: {
          probes: [{ name: 'mcp-servers', mode: 'detect-only', commands: ['npx @playwright/mcp@latest'] }],
        },
      };
      writeFileSync(manifestPath, JSON.stringify(badManifest), 'utf8');

      const result = run(['--manifest', manifestPath]) as ManifestValidation;

      expect(result.unexpectedFloatingReferences).toHaveLength(1);
      expect(result.unexpectedFloatingReferences[0].path).toContain('tier2');
      expect(process.exitCode).toBe(2);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('unexpected floating latest reference');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run() exits 0 for manifests with floating latest only in tier1 update/rollback channels', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-harness-'));
    const manifestPath = path.join(dir, 'managed-components.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const allowedManifest = {
        ...manifest(),
        tier1: [
          {
            name: 'claude',
            kind: 'native',
            update: ['claude', 'install', 'latest'],
            rollback: ['claude', 'install', '{previous}'],
            smoke: ['claude', '--version'],
          },
          { name: 'codex', kind: 'npm-global', package: '@openai/codex', smoke: ['codex', '--version'] },
          { name: 'opencode', kind: 'native', smoke: ['opencode', '--version'] },
        ],
        tier2: { probes: [{ name: 'runtime', mode: 'detect-only' }] },
      };
      writeFileSync(manifestPath, JSON.stringify(allowedManifest), 'utf8');

      const result = run(['--manifest', manifestPath]) as ManifestValidation;

      expect(result.unexpectedFloatingReferences).toHaveLength(0);
      expect(result.allowedFloatingReferences.length).toBeGreaterThan(0);
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run() prints JSON and plain output for npm cooldown config checks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-harness-'));
    const npmrcPath = path.join(dir, '.npmrc');
    const stderrPath = path.join(dir, 'stderr.txt');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(npmrcPath, 'min-release-age=7\n', 'utf8');
      writeFileSync(stderrPath, '', 'utf8');

      const jsonResult = run([
        '--npm-cooldown-config',
        '--npm-version',
        '11.12.1',
        '--min-version',
        '11.12.0',
        '--expected-days',
        '7',
        '--npmrc-file',
        npmrcPath,
        '--stderr-file',
        stderrPath,
        '--install-exit-code',
        '0',
        '--json',
      ]);
      const plainResult = run([
        '--npm-cooldown-config',
        '--npm-version',
        '11.12.1',
        '--min-version',
        '11.12.0',
        '--expected-days',
        '7',
        '--npmrc-file',
        npmrcPath,
        '--stderr-file',
        stderrPath,
        '--install-exit-code',
        '0',
      ]);

      expect((jsonResult as { ok: boolean }).ok).toBe(true);
      expect((plainResult as { ok: boolean }).ok).toBe(true);
      expect(JSON.parse(String(log.mock.calls[0][0])).ok).toBe(true);
      expect(log.mock.calls.flat().join('\n')).toContain('codex npm cooldown config ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run() rejects malformed CLI arguments and invalid install exit codes', () => {
    expect(() => run(['positional'])).toThrow('unexpected argument');
    expect(() => run(['--manifest'])).toThrow('missing value for --manifest');
    expect(() => run([
      '--npm-cooldown-config',
      '--npm-version',
      '11.12.1',
      '--min-version',
      '11.12.0',
      '--expected-days',
      '7',
      '--npmrc-file',
      'missing',
      '--stderr-file',
      'missing',
      '--install-exit-code',
      '-1',
    ])).toThrow('--install-exit-code must be a non-negative integer');
  });

  it('harness-maintenance.sh publishes state with exclusive private writes', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'deploy/scripts/harness-maintenance.sh'),
      'utf8',
    );

    expect(source).toContain('chmod 700 "$STATE_DIR"');
    expect(source).toContain("flag: 'wx'");
    expect(source).toContain('mode: 0o600');
    expect(source).toContain('[ -L "$STATE_FILE" ]');
    expect(source).toContain('chmod 600 "$STATE_FILE"');
  });

  it('harness-maintenance.sh validates PATH node fallback before running TypeScript guards', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'deploy/scripts/harness-maintenance.sh'),
      'utf8',
    );

    expect(source).toContain('lib/resolve-node.sh');
    expect(source).toContain('whatsoup_validate_node_compatibility "$REPO_ROOT" "$REPO_NODE_BIN"');
    expect(source).toContain('WARN: pinned node v${NVMRC_NODE_VERSION} not found; using PATH node');
    expect(source).toContain('WARN: resolved PATH Node major differs from .nvmrc pin');
    expect(source).not.toContain('REPO_NODE_BIN="$(command -v node || true)"');
  });

  it('harness-maintenance.sh can install a missing OpenCode harness into a user-owned prefix', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'deploy/scripts/harness-maintenance.sh'),
      'utf8',
    );

    expect(source).toContain('NPM_GLOBAL_PREFIX="${WHATSOUP_HARNESS_NPM_GLOBAL_PREFIX:-$HOME/.local/share/whatsoup/npm-global}"');
    expect(source).toContain('npm_latest_eligible_version opencode-ai');
    expect(source).toContain('install_opencode_npm "$target"');
    expect(source).toContain('--prefix "$NPM_GLOBAL_PREFIX"');
    expect(source).toContain('opencode-ai@$target');
  });
});
