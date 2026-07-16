import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkFleetBotHardeningParity,
  DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH,
  run,
} from '../../scripts/check-fleet-bot-hardening-parity.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-fleet-hardening-parity-'));
  tempRoots.push(root);
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

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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
});
