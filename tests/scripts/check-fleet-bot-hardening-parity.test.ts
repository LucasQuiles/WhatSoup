import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  checkFleetBotHardeningParity,
  DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH,
  run,
} from '../../scripts/check-fleet-bot-hardening-parity.ts';
import { receiptCapabilityDigest } from '../../scripts/lib/fleet-receipt-digest.ts';
import { rosterEpoch, rosterInventory } from '../../scripts/lib/fleet-roster-inventory.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmp = trackTmpDirs('whatsoup-fleet-hardening-');

// Same conventional path the guard resolves against `cwd` (mirrors
// `deploy/scripts/lib/bot_errors_roster.py`'s `default_roster_path()`).
const FLEET_ROSTER_FIXTURE_PATH = 'deploy/bot-errors-expected-fleet.json';

function makeRoot(): string {
  const root = tmp.make('parity');
  mkdirSync(path.join(root, 'docs/reliability-runner'), { recursive: true });
  return root;
}

function writeFixtureFile(root: string, filePath: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
  writeFileSync(path.join(root, filePath), text, 'utf8');
}

function writeFixtureStandard(root: string): void {
  writeFixtureFile(root, 'docs/runbooks/fleet-bot-hardening-standard.md', [
    '### A. Turn-Capability Health',
    '### D. Fallback Chain',
  ].join('\n'));
}

function writeFixtureManifest(root: string, overrides: Record<string, unknown> = {}): void {
  const manifest = {
    schemaVersion: 1,
    updated: '2026-06-15',
    standard: 'docs/runbooks/fleet-bot-hardening-standard.md',
    scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 2 },
    summary: { total: 2, hardened: 1, pendingRollout: 1, blocked: 0, acceptedException: 0 },
    capabilities: [
      'turn-capability-health',
      'primary-model-usability-probe',
      'release-drift-check-job',
      'fallback-chain',
    ],
    rows: [
      {
        id: 'reference-incident-bot',
        status: 'hardened',
        capabilities: {
          'turn-capability-health': 'proven',
          'primary-model-usability-probe': 'proven',
          'release-drift-check-job': 'proven',
          'fallback-chain': 'proven',
        },
        evidence: ['fixture evidence'],
        verifiedAt: '2026-06-15',
      },
      {
        id: 'peer-agent-bot-1',
        status: 'pending-rollout',
        capabilities: {
          'turn-capability-health': 'missing-live-proof',
          'primary-model-usability-probe': 'missing-live-proof',
          'release-drift-check-job': 'missing-live-proof',
          'fallback-chain': 'missing-live-proof',
        },
        evidence: ['fixture inventory'],
        nextAction: 'roll out after named approval',
      },
    ],
    sourceAnchors: [
      {
        file: 'docs/runbooks/fleet-bot-hardening-standard.md',
        anchors: ['### A. Turn-Capability Health', '### D. Fallback Chain'],
      },
    ],
    ...overrides,
  };
  writeFileSync(
    path.join(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function writeFixtureRoster(root: string, hosts: unknown[]): string {
  const rosterPath = path.join(root, FLEET_ROSTER_FIXTURE_PATH);
  writeFixtureFile(root, FLEET_ROSTER_FIXTURE_PATH, `${JSON.stringify({ schemaVersion: 1, hosts }, null, 2)}\n`);
  return rosterPath;
}

// Fixture receipt-file bundle (#1867 criterion 1, guard-side). Shape matches
// the contract `fleet-receipt-digest.ts` defines for a receipt-capture
// producer: identity-tagged fields (`commit`, `schemaMigration`, `provider`,
// `modelUsabilityStatus`, `fallbackChain[].{provider,model,eligible}`,
// `driftCheck.ok`) plus volatile fields the digest deliberately ignores
// (`generatedAt`, `uptimeSeconds`, fallback turn counters).
function makeFixtureReceiptBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commit: 'c'.repeat(40),
    schemaMigration: 44,
    provider: 'claude-cli',
    modelUsabilityStatus: 'usable',
    fallbackChain: [{ provider: 'openai', model: 'gpt-fallback', eligible: true, turnCount: 3 }],
    driftCheck: { ok: true },
    generatedAt: '2026-06-18T00:00:00Z',
    uptimeSeconds: 12345,
    ...overrides,
  };
}

// Writes a fixture receipt file under the conventional path (design §5/§6:
// `docs/reliability-runner/fleet-bot-hardening-receipts/<row-id>.json`) and
// returns both the repo-relative path and the digest declared in the
// manifest row (`sha256:<64-hex>`), computed from the bundle as written.
function writeFixtureReceiptFile(
  root: string,
  rowId: string,
  bundle: Record<string, unknown>,
): { relPath: string; digest: string } {
  const relPath = `docs/reliability-runner/fleet-bot-hardening-receipts/${rowId}.json`;
  writeFixtureFile(root, relPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return { relPath, digest: `sha256:${receiptCapabilityDigest(bundle)}` };
}

function makeFixtureHosts(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, index) => ({
    host: `fixture-host-${index}`,
    role: 'bot-host',
    collectorRemote: false,
    instances: [
      { name: `fixture-bot-${index}`, service: `fixture-bot-${index}.service`, expected: 'always_on' },
    ],
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('fleet bot hardening parity guard', () => {
  it('passes for the tracked repository parity manifest', () => {
    const result = checkFleetBotHardeningParity(repoRoot);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.rows).toBe(7);
    expect(result.sourceAnchors).toBeGreaterThanOrEqual(1);
  });

  it('fails when the parity manifest updated timestamp is older than the freshness budget', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, { updated: '2026-06-15' });

    // Inject a clock far past the documented max age so the age math is
    // unambiguous and independent of the real wall clock or the constant.
    const staleNow = new Date('2027-01-01T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, staleNow);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stale-updated' }),
    ]));
  });

  it('accepts a parity manifest whose updated timestamp is within the freshness budget', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, { updated: '2026-06-15' });

    const freshNow = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, freshNow);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('fails when a row verifiedAt timestamp is older than the freshness budget', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture evidence'],
          verifiedAt: '2026-01-01',
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    // updated 2026-06-15 stays fresh (5 days); the row verifiedAt 2026-01-01 is ~170 days stale.
    const now = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stale-row-verified-at' }),
    ]));
  });

  it('fails when a row verifiedAt timestamp is in the future', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture evidence'],
          verifiedAt: '2026-12-31',
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const now = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'future-row-verified-at' }),
    ]));
  });

  it('fails when a row verifiedAt is not a valid date shape', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture evidence'],
          verifiedAt: 'not-a-date',
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const now = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-row-verified-at' }),
    ]));
  });

  it('accepts a row whose verifiedAt is within the freshness budget', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture evidence'],
          verifiedAt: '2026-06-18',
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const now = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('fails closed when a hardened row omits verifiedAt', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture evidence'],
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const now = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-row-verified-at' }),
    ]));
  });

  it('fails when the manifest updated timestamp is in the future', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, { updated: '2026-12-31' });

    const now = new Date('2026-06-20T00:00:00Z');
    const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'future-updated' }),
    ]));
  });

  it('fails when a hardened row has an unproven capability', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'missing-live-proof',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture evidence'],
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'hardened-row-not-proven' }),
    ]));
  });

  it('fails when a source anchor file no longer carries the required marker', () => {
    const root = makeRoot();
    writeFixtureFile(root, 'docs/runbooks/fleet-bot-hardening-standard.md', '### A. Turn-Capability Health\n');
    writeFixtureManifest(root);

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'source-anchor-missing-anchor',
        path: 'docs/runbooks/fleet-bot-hardening-standard.md',
      }),
    ]));
  });

  it('fails when the public manifest includes private instance labels', () => {
    const root = makeRoot();
    const disallowedInstanceLabel = `${['m', 'w'].join('')}-bot`;
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: [`${disallowedInstanceLabel} should stay in operator-private evidence`],
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'private-label' }),
    ]));
  });

  it('fails when the public manifest includes private host labels or network addresses', () => {
    const root = makeRoot();
    const disallowedHostLabel = ['n', 'u', 'cles'].join('');
    const disallowedNetworkAddress = ['100', '91', '13', '7'].join('.');
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: [`${disallowedHostLabel} and ${disallowedNetworkAddress} stay in private operator notes`],
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'private-label' }),
    ]));
  });

  it('fails when a hardened row has no evidence list', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'reference-incident-bot',
          status: 'hardened',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
    });

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'evidence-not-list' }),
      expect.objectContaining({ code: 'hardened-row-without-evidence' }),
    ]));
  });

  it('fails when a pending rollout row has no gap or next action', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'peer-agent-bot-1',
          status: 'pending-rollout',
          capabilities: {
            'turn-capability-health': 'proven',
            'primary-model-usability-probe': 'proven',
            'release-drift-check-job': 'proven',
            'fallback-chain': 'proven',
          },
          evidence: ['fixture inventory'],
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
      summary: { total: 1, hardened: 0, pendingRollout: 1, blocked: 0, acceptedException: 0 },
    });

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'pending-row-without-gap' }),
      expect.objectContaining({ code: 'pending-row-without-next-action' }),
    ]));
  });

  it('fails when blocked or exception rows omit their required status details', () => {
    const root = makeRoot();
    writeFixtureStandard(root);
    writeFixtureManifest(root, {
      rows: [
        {
          id: 'peer-agent-bot-1',
          status: 'blocked',
          capabilities: {
            'turn-capability-health': 'blocked',
            'primary-model-usability-probe': 'blocked',
            'release-drift-check-job': 'blocked',
            'fallback-chain': 'blocked',
          },
          evidence: ['fixture inventory'],
        },
        {
          id: 'peer-agent-bot-2',
          status: 'accepted-exception',
          capabilities: {
            'turn-capability-health': 'accepted-exception',
            'primary-model-usability-probe': 'accepted-exception',
            'release-drift-check-job': 'accepted-exception',
            'fallback-chain': 'accepted-exception',
          },
          evidence: ['fixture exception review'],
        },
      ],
      scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 2 },
      summary: { total: 2, hardened: 0, pendingRollout: 0, blocked: 1, acceptedException: 1 },
    });

    const result = checkFleetBotHardeningParity(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'blocked-row-without-next-action' }),
      expect.objectContaining({ code: 'exception-row-without-exception' }),
    ]));
  });

  it('CLI run reports actionable findings and sets exitCode on failure', () => {
    const root = makeRoot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run([], root);

    expect(result.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('manifest-unreadable');
  });

  describe('separated verdict (#1867 criterion 4)', () => {
    it('reports a broken source anchor as sourceAnchorParity failure without failing runtimeParity', () => {
      const root = makeRoot();
      // Otherwise-valid manifest (default fixture rows/dates all pass), but the
      // standard file is missing the '### D. Fallback Chain' marker required by
      // writeFixtureManifest's sourceAnchors entry.
      writeFixtureFile(root, 'docs/runbooks/fleet-bot-hardening-standard.md', '### A. Turn-Capability Health\n');
      writeFixtureManifest(root);

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.sourceAnchorParity.ok).toBe(false);
      expect(result.sourceAnchorParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'source-anchor-missing-anchor' }),
      ]));
      expect(result.runtimeParity.ok).toBe(true);
      expect(result.runtimeParity.findings).toEqual([]);
    });

    it('reports a stale row verifiedAt as runtimeParity failure without failing sourceAnchorParity', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-01-01',
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      // updated 2026-06-15 stays fresh (5 days); the row verifiedAt 2026-01-01 is ~170 days stale.
      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'stale-row-verified-at' }),
      ]));
      expect(result.sourceAnchorParity.ok).toBe(true);
      expect(result.sourceAnchorParity.findings).toEqual([]);
    });
  });

  it('is wired into branch and release verification between source and runtime drift guards', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['guard:fleet-bot-hardening-parity']).toContain('check-fleet-bot-hardening-parity.ts');
    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain).toContain('npm run guard:fleet-bot-hardening-parity');
      expect(chain.indexOf('npm run guard:source-runtime-drift')).toBeLessThan(
        chain.indexOf('npm run guard:fleet-bot-hardening-parity'),
      );
      expect(chain.indexOf('npm run guard:fleet-bot-hardening-parity')).toBeLessThan(
        chain.indexOf('npm run guard:bot-errors-runtime-manifest'),
      );
    }
  });

  describe('inventory-epoch binding (#1867 criterion 3)', () => {
    it('emits no finding when inventoryBinding is absent (validate-when-present; protects the tracked manifest)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root);

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
      expect(result.runtimeParity.findings).toEqual([]);
    });

    it('accepts inventoryBinding whose declared digest/count/epoch match the independently recomputed roster', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const rosterPath = writeFixtureRoster(root, makeFixtureHosts(2));
      const rosterData = JSON.parse(readFileSync(rosterPath, 'utf8'));
      const inventory = rosterInventory(rosterData);
      const epoch = rosterEpoch(rosterPath);
      expect(epoch).not.toBeNull();

      writeFixtureManifest(root, {
        inventoryBinding: {
          rosterDigest: inventory.digest,
          rosterEpoch: epoch,
          expectedInstanceCount: inventory.expectedInstanceCount,
        },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.runtimeParity.findings).toEqual([]);
      expect(result.sourceAnchorParity.ok).toBe(true);
    });

    it('fails with roster-digest-mismatch and roster-instance-count-mismatch when membership changed (declared binding computed from an N-1 fixture)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      // The real/current roster has 3 hosts...
      const rosterPath = writeFixtureRoster(root, makeFixtureHosts(3));
      // ...but the manifest declares a binding computed from a stale 2-host roster.
      const staleInventory = rosterInventory({ schemaVersion: 1, hosts: makeFixtureHosts(2) });
      const epoch = rosterEpoch(rosterPath);
      expect(epoch).not.toBeNull();

      writeFixtureManifest(root, {
        inventoryBinding: {
          rosterDigest: staleInventory.digest,
          rosterEpoch: epoch,
          expectedInstanceCount: staleInventory.expectedInstanceCount,
        },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'roster-digest-mismatch' }),
        expect.objectContaining({ code: 'roster-instance-count-mismatch' }),
      ]));
    });

    it('fails with future-roster-epoch when the declared rosterEpoch is later than the roster file mtime', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const rosterPath = writeFixtureRoster(root, makeFixtureHosts(2));
      const rosterData = JSON.parse(readFileSync(rosterPath, 'utf8'));
      const inventory = rosterInventory(rosterData);
      const epoch = rosterEpoch(rosterPath);
      expect(epoch).not.toBeNull();

      writeFixtureManifest(root, {
        inventoryBinding: {
          rosterDigest: inventory.digest,
          rosterEpoch: (epoch as number) + 1_000_000,
          expectedInstanceCount: inventory.expectedInstanceCount,
        },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'future-roster-epoch' }),
      ]));
    });

    it('fails closed with invalid-inventory-binding when the field is present but malformed', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        inventoryBinding: { rosterDigest: 'not-hex', rosterEpoch: 'not-a-number', expectedInstanceCount: -1 },
      });

      const result = checkFleetBotHardeningParity(root);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-inventory-binding' }),
      ]));
    });

    it('fails closed with roster-unreadable when inventoryBinding is present but the fleet roster file cannot be read', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      // Deliberately do not write deploy/bot-errors-expected-fleet.json.
      writeFixtureManifest(root, {
        inventoryBinding: { rosterDigest: 'a'.repeat(64), rosterEpoch: 0, expectedInstanceCount: 1 },
      });

      const result = checkFleetBotHardeningParity(root);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'roster-unreadable' }),
      ]));
    });
  });

  // Release/config identity binding (#1867 criterion 2, partial). Row-level
  // `releaseIdentity` shape/format checks only, validate-when-present -- a
  // row that omits it emits no finding (protects the tracked manifest, whose
  // rows do not yet declare this field). The receipt cross-check
  // (`release-identity-receipt-mismatch` / `verified-before-service-restart`)
  // is explicitly deferred to a later increment that needs the runtime
  // receipt; not implemented here.
  describe('release/config identity binding (#1867 criterion 2, partial)', () => {
    it('emits no finding when releaseIdentity is absent (validate-when-present; protects the tracked manifest)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root);

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
      expect(result.runtimeParity.findings).toEqual([]);
    });

    it('accepts a row whose releaseIdentity is well-formed (40-hex commit, numeric schemaMigration, non-empty provider)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            releaseIdentity: {
              commit: 'a'.repeat(40),
              schemaMigration: 44,
              provider: 'claude-cli',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('fails with invalid-row-release-commit when releaseIdentity.commit is not a full 40-hex sha', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            releaseIdentity: {
              commit: 'not-a-sha',
              schemaMigration: 44,
              provider: 'claude-cli',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-commit' }),
      ]));
      expect(result.runtimeParity.findings).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-identity' }),
      ]));
    });

    it('fails with invalid-row-release-identity when releaseIdentity is present but missing schemaMigration', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            releaseIdentity: {
              commit: 'a'.repeat(40),
              provider: 'claude-cli',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-identity' }),
      ]));
    });

    it('fails with invalid-row-release-identity when releaseIdentity.provider is an empty string', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            releaseIdentity: {
              commit: 'a'.repeat(40),
              schemaMigration: 44,
              provider: '',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-identity' }),
      ]));
    });

    it('fails with invalid-row-release-identity when releaseIdentity.commit is absent (missing, not merely malformed)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            releaseIdentity: {
              schemaMigration: 44,
              provider: 'claude-cli',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-identity' }),
      ]));
      expect(result.runtimeParity.findings).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-commit' }),
      ]));
    });

    it('fails with invalid-row-release-identity when releaseIdentity is present but not an object', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            releaseIdentity: 'not-an-object',
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-release-identity' }),
      ]));
    });
  });

  // Runtime receipt validation (#1867 criterion 1, guard-side half; design
  // §6/§7.2, storage Option B). Validate-when-present: a row that omits
  // `receipt` emits no finding at all (protects the tracked manifest, whose
  // rows do not yet declare this field -- populating it is the deferred
  // manifest-migration increment). Whenever a row *does* declare a receipt,
  // its shape/format must be fail-closed-correct, and -- because Option B
  // commits the sanitized receipt bytes -- the guard independently recomputes
  // the capability-identity digest (`fleet-receipt-digest.ts`) from the
  // referenced file rather than trusting the declared digest string. This
  // increment does NOT require `receipt` on hardened rows (that is the
  // deferred manifest-migration increment) and does NOT cross-check
  // `receipt` against `releaseIdentity` (`release-identity-receipt-mismatch`
  // / `verified-before-service-restart`, design §7.3, also deferred -- those
  // need both fields present on real rows, not just validated in isolation).
  describe('runtime receipt validation (#1867 criterion 1, guard-side)', () => {
    it('emits no finding when receipt is absent (validate-when-present; protects the tracked manifest)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root);

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
      expect(result.runtimeParity.findings).toEqual([]);
    });

    it('accepts a row with a present, valid receipt whose recomputed digest matches the referenced file', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('accepts a valid receipt even when its file also carries volatile fields that differ from a freshly re-captured bundle (digest excludes them)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      // The digest is computed over the identity projection only, so a
      // receipt whose volatile fields (uptime, generatedAt, turn counters)
      // would differ from "a fresh capture right now" still matches the
      // digest declared in the manifest -- this is the core reason the
      // projection exists (design §4): repeat captures of a healthy,
      // unchanged instance must not manufacture drift.
      const bundle = makeFixtureReceiptBundle({
        generatedAt: '2020-01-01T00:00:00Z',
        uptimeSeconds: 1,
        fallbackChain: [{ provider: 'openai', model: 'gpt-fallback', eligible: true, turnCount: 999999 }],
      });
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('fails with stale-row-receipt when receipt.capturedAt is older than the freshness budget', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-01-01T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      // 2026-01-01 is ~170 days before the injected now, past the 90-day budget.
      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'stale-row-receipt' }),
      ]));
    });

    it('fails with future-row-receipt-captured-at when receipt.capturedAt is later than the injected now', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-12-31T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'future-row-receipt-captured-at' }),
      ]));
    });

    it('fails with invalid-row-receipt-captured-at when receipt.capturedAt is not parseable ISO-8601', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: 'not-a-timestamp', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-receipt-captured-at' }),
      ]));
    });

    it.each(['2026/06/18', '2026'])(
      'fails with invalid-row-receipt-captured-at when receipt.capturedAt (%s) is Date.parse-able but not ISO-8601',
      (capturedAt) => {
        const root = makeRoot();
        writeFixtureStandard(root);
        const bundle = makeFixtureReceiptBundle();
        const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

        writeFixtureManifest(root, {
          rows: [
            {
              id: 'reference-incident-bot',
              status: 'hardened',
              capabilities: {
                'turn-capability-health': 'proven',
                'primary-model-usability-probe': 'proven',
                'release-drift-check-job': 'proven',
                'fallback-chain': 'proven',
              },
              evidence: ['fixture evidence'],
              verifiedAt: '2026-06-18',
              receipt: { digest, capturedAt, path: relPath },
            },
          ],
          scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
          summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
        });

        // Both fixtures are accepted by the raw `Date.parse` this guard used
        // to rely on exclusively (Node happily parses `2026/06/18` as local
        // midnight and `2026` as a bare-year UTC timestamp), so a
        // Date.parse-only check would wrongly accept them even though the
        // finding message promises "ISO-8601". The guard must reject both
        // via an explicit ISO-8601 shape pre-check.
        const now = new Date('2026-06-20T00:00:00Z');
        const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

        expect(result.ok).toBe(false);
        expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'invalid-row-receipt-captured-at' }),
        ]));
      },
    );

    it('accepts receipt.capturedAt with a numeric UTC offset (design-valid ISO-8601 shape, not just literal Z)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-06-18T00:00:00+00:00', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('fails with invalid-row-receipt-digest when receipt.digest does not match ^sha256:[0-9a-f]{64}$', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest: 'not-a-valid-digest', capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-receipt-digest' }),
      ]));
      // A malformed digest must not also be reported as a digest MISMATCH --
      // it's a shape problem, not a recompute-and-compare problem.
      expect(result.runtimeParity.findings).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt-digest-mismatch' }),
      ]));
    });

    it('fails with receipt-file-missing when receipt.path does not resolve to an existing file', () => {
      const root = makeRoot();
      writeFixtureStandard(root);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: {
              digest: `sha256:${'a'.repeat(64)}`,
              capturedAt: '2026-06-18T00:00:00Z',
              path: 'docs/reliability-runner/fleet-bot-hardening-receipts/does-not-exist.json',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt-file-missing' }),
      ]));
    });

    it('fails with receipt-file-missing when receipt.path escapes the repository', () => {
      const root = makeRoot();
      writeFixtureStandard(root);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: {
              digest: `sha256:${'a'.repeat(64)}`,
              capturedAt: '2026-06-18T00:00:00Z',
              path: '../outside-repo.json',
            },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt-file-missing' }),
      ]));
    });

    it('fails with receipt-digest-mismatch when the referenced receipt file is tampered after the digest was computed (identity field mutated)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      // Tamper with an IDENTITY field (commit) after the digest was computed
      // and declared in the manifest -- this must fail closed.
      const tampered = { ...bundle, commit: 'd'.repeat(40) };
      writeFixtureFile(root, relPath, `${JSON.stringify(tampered, null, 2)}\n`);

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt-digest-mismatch' }),
      ]));
    });

    it('accepts an unchanged digest when the referenced receipt file is tampered on a VOLATILE field only (the projection excludes it)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const bundle = makeFixtureReceiptBundle();
      const { relPath, digest } = writeFixtureReceiptFile(root, 'reference-incident-bot', bundle);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest, capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      // Tamper with a VOLATILE-only field (uptimeSeconds) after the digest
      // was computed -- this must NOT be reported as a mismatch, because the
      // whole point of hashing a projection instead of the raw bundle is
      // that volatile fields never affect the digest.
      const touched = { ...bundle, uptimeSeconds: 999999999, generatedAt: '2030-01-01T00:00:00Z' };
      writeFixtureFile(root, relPath, `${JSON.stringify(touched, null, 2)}\n`);

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('fails closed with invalid-row-receipt when receipt is present but not an object', () => {
      const root = makeRoot();
      writeFixtureStandard(root);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: 'not-an-object',
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-receipt' }),
      ]));
    });

    it('fails closed with the malformed-shape finding when receipt fields are missing entirely (empty object)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: {},
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-row-receipt-digest' }),
        expect.objectContaining({ code: 'invalid-row-receipt-captured-at' }),
        expect.objectContaining({ code: 'receipt-file-missing' }),
      ]));
    });

    it('fails closed with receipt-digest-mismatch when the receipt file cannot be parsed as JSON', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      const relPath = 'docs/reliability-runner/fleet-bot-hardening-receipts/reference-incident-bot.json';
      writeFixtureFile(root, relPath, 'not valid json{{{');

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest: `sha256:${'a'.repeat(64)}`, capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt-digest-mismatch' }),
      ]));
    });

    it('fails closed with receipt-digest-mismatch when the receipt file is valid JSON but missing an identity field (e.g. no commit)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      // Deliberately distinct from the JSON-parse-failure fixture above:
      // this file parses cleanly as JSON (`{}` is valid JSON), so the
      // guard's `JSON.parse` call succeeds and it is only
      // `receiptCapabilityDigest`'s own fail-closed validation (throwing
      // `ReceiptDigestError` because `commit` etc. are absent) that lands in
      // the shared `catch` block below. Without this test, that path was
      // only ever exercised indirectly by the JSON-parse-failure case.
      const relPath = 'docs/reliability-runner/fleet-bot-hardening-receipts/reference-incident-bot.json';
      writeFixtureFile(root, relPath, `${JSON.stringify({}, null, 2)}\n`);

      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
            receipt: { digest: `sha256:${'a'.repeat(64)}`, capturedAt: '2026-06-18T00:00:00Z', path: relPath },
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(false);
      expect(result.runtimeParity.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt-digest-mismatch' }),
      ]));
    });

    it('does not require receipt on a hardened row (validate-when-present, not required-when-hardened -- that is the deferred manifest-migration increment)', () => {
      const root = makeRoot();
      writeFixtureStandard(root);
      writeFixtureManifest(root, {
        rows: [
          {
            id: 'reference-incident-bot',
            status: 'hardened',
            capabilities: {
              'turn-capability-health': 'proven',
              'primary-model-usability-probe': 'proven',
              'release-drift-check-job': 'proven',
              'fallback-chain': 'proven',
            },
            evidence: ['fixture evidence'],
            verifiedAt: '2026-06-18',
          },
        ],
        scope: { description: 'fixture', inventoryPolicy: 'redacted', cohortSize: 1 },
        summary: { total: 1, hardened: 1, pendingRollout: 0, blocked: 0, acceptedException: 0 },
      });

      const now = new Date('2026-06-20T00:00:00Z');
      const result = checkFleetBotHardeningParity(root, DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH, now);

      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
      expect(result.runtimeParity.findings).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'missing-row-receipt' }),
      ]));
    });
  });
});
