/**
 * Refresh rollback-fence behavior against an isolated simulated launchd world.
 * Test titles deliberately retain their original release:activate --plan/--apply
 * describe labels so qualification full-name membership is unchanged.
 */
import { readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseActivationArgs,
  RELEASE_ACTIVATE_EXIT,
} from '../../scripts/release-activate.ts';
import { applyActivation } from '../../scripts/lib/release-activation/apply.ts';
import { buildActivationContext } from '../../scripts/lib/release-activation/plan.ts';
import {
  activationArgs,
  diagnosticBody,
  type Fixture,
  installFixture,
  INSTANCE,
  NEW_COMMIT,
  OLD_COMMIT,
  run,
  SimulatedLaunchd,
  writeRefreshRollbackFence,
  writeRefreshRollbackFenceRaw,
  rewriteReleaseManifestCommit,
  REFRESH_ROLLBACK_FENCE_REL,
} from '../helpers/release-activate-world.ts';

/** The fence this repository ships; it requires the stalled-operation hold (#3903) of a rollback target. */
const SHIPPED_REFRESH_FENCE = readFileSync(path.resolve(import.meta.dirname, '../..', REFRESH_ROLLBACK_FENCE_REL), 'utf8');

/** Release a804bb2a's exact fence bytes: refresh owner only, no knowledge of the stalled-operation hold. */
const A804BB2A_REFRESH_FENCE = `{
  "schemaVersion": 1,
  "activationRequirements": {
    "rollbackTarget": {
      "claudeRefreshOwnerV3": 3
    }
  },
  "rollbackCapabilities": {
    "claudeRefreshOwnerV3": 3
  }
}
`;

let fixture: Fixture;

/** A world whose new release fails verification, so apply attempts an automatic rollback. */
function failingNewReleaseWorld(): SimulatedLaunchd {
  return new SimulatedLaunchd(fixture, {
    health: (root) => ({
      status: 200,
      body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease),
    }),
  });
}

function useFixture(next: Fixture): void {
  fixture = next;
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
}

beforeEach(() => {
  useFixture(installFixture());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('release:activate --plan', () => {
  async function expectRefreshFencePlanRefusal(mutate: () => void): Promise<void> {
    mutate();
    const world = new SimulatedLaunchd(fixture);
    const result = await run(world, activationArgs(fixture));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    const failed = (result.json.preconditions as Array<{ id: string; ok: boolean }>)
      .filter((entry) => !entry.ok).map((entry) => entry.id);
    expect(failed).toContain('release-refresh-rollback-fence-valid');
    expect(world.mutatingCalls()).toEqual([]);
  }

  it('refuses a candidate with an unsealed existing refresh fence file', async () => {
    await expectRefreshFencePlanRefusal(() => {
      writeFileSync(path.join(fixture.newRelease, REFRESH_ROLLBACK_FENCE_REL), JSON.stringify({ schemaVersion: 1 }));
    });
  });

  it('refuses a candidate with an oversized sealed refresh fence file', async () => {
    await expectRefreshFencePlanRefusal(() => {
      writeRefreshRollbackFenceRaw(fixture.newRelease, ' '.repeat(16 * 1024 + 1));
    });
  });

  it('refuses a candidate with a refresh fence leaf symlink', async () => {
    await expectRefreshFencePlanRefusal(() => {
      const target = path.join(fixture.newRelease, 'deploy', 'refresh-fence-target.json');
      writeFileSync(target, JSON.stringify({ schemaVersion: 1 }));
      symlinkSync(target, path.join(fixture.newRelease, REFRESH_ROLLBACK_FENCE_REL));
    });
  });

  it('refuses a candidate with an invalid refresh fence schema', async () => {
    await expectRefreshFencePlanRefusal(() => {
      writeRefreshRollbackFenceRaw(fixture.newRelease, JSON.stringify({
        schemaVersion: 2,
        activationRequirements: { rollbackTarget: { claudeRefreshOwnerV3: 3 } },
        rollbackCapabilities: { claudeRefreshOwnerV3: 3 },
      }));
    });
  });

  it('refuses a candidate with a nonpositive refresh fence capability', async () => {
    await expectRefreshFencePlanRefusal(() => {
      writeRefreshRollbackFenceRaw(fixture.newRelease, JSON.stringify({
        schemaVersion: 1,
        activationRequirements: { rollbackTarget: { claudeRefreshOwnerV3: 3 } },
        rollbackCapabilities: { claudeRefreshOwnerV3: 0 },
      }));
    });
  });

  it.each(['rollbackTarget', 'rollbackCapabilities'] as const)(
    'refuses a candidate whose refresh fence %s names an unknown key',
    async (section) => {
      const known = { claudeRefreshOwnerV3: 3, stalledOperationHoldV1: 1 };
      const withUnknown = { ...known, unknownFenceV1: 1 };
      await expectRefreshFencePlanRefusal(() => {
        writeRefreshRollbackFenceRaw(fixture.newRelease, JSON.stringify({
          schemaVersion: 1,
          activationRequirements: { rollbackTarget: section === 'rollbackTarget' ? withUnknown : known },
          rollbackCapabilities: section === 'rollbackCapabilities' ? withUnknown : known,
        }));
      });
    },
  );

});

describe('release:activate --apply', () => {
  it('permits forward activation from a legacy target while disclosing rollback incompatibility', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    const world = new SimulatedLaunchd(fixture);

    const plan = await run(world, activationArgs(fixture));
    expect(plan.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(plan.json.rollbackRefreshFence).toMatchObject({
      candidateRequirement: { claudeRefreshOwnerV3: 3, stalledOperationHoldV1: 0 },
      targetCapabilityAtPlan: { claudeRefreshOwnerV3: 0, stalledOperationHoldV1: 0 },
      targetCompatibleAtPlan: false,
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('blocks automatic rollback to a legacy target before restart', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => ({
        status: 200,
        body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease),
      }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.outcome).toBe('rollback-blocked-refresh-fence');
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'before-instance-stop' });
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.newRelease, 'deploy', 'whatsoup'));
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it.each(['malformed', 'unsealed', 'hash-mismatch'] as const)(
    'blocks automatic rollback when target refresh fence is %s',
    async (kind) => {
      writeRefreshRollbackFence(fixture.newRelease);
      if (kind === 'unsealed') {
        writeRefreshRollbackFence(fixture.oldRelease, { seal: false });
      } else {
        writeRefreshRollbackFence(fixture.oldRelease);
        if (kind === 'malformed') {
          writeRefreshRollbackFenceRaw(fixture.oldRelease, '{');
        } else {
          writeFileSync(path.join(fixture.oldRelease, REFRESH_ROLLBACK_FENCE_REL), JSON.stringify({
            schemaVersion: 1,
            activationRequirements: { rollbackTarget: { claudeRefreshOwnerV3: 3 } },
            rollbackCapabilities: { claudeRefreshOwnerV3: 3 },
          }, null, 2));
        }
      }
      const world = new SimulatedLaunchd(fixture, {
        health: (root) => ({
          status: 200,
          body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease),
        }),
      });

      const result = await run(world, activationArgs(fixture, ['--apply']));

      expect(result.code).toBe(5);
      expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'before-instance-stop' });
      expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
    },
  );

  it('refuses before live switch when the sealed candidate refresh fence requirement changes after planning', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    const world = new SimulatedLaunchd(fixture);
    const context = await buildActivationContext(world.host(), parseActivationArgs(activationArgs(fixture, ['--apply'])));
    writeRefreshRollbackFence(fixture.newRelease, { requirement: 4 });

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('refused');
    expect(outcome.steps).toContainEqual(expect.objectContaining({
      step: 'recheck-refresh-rollback-fence-requirement-before-switch', ok: false,
    }));
    expect(world.mutatingCalls()).toEqual([]);
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
  });

  it('refuses before live switch when the candidate refresh fence bytes change with the same requirement', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    const world = new SimulatedLaunchd(fixture);
    const context = await buildActivationContext(world.host(), parseActivationArgs(activationArgs(fixture, ['--apply'])));
    writeRefreshRollbackFence(fixture.newRelease, { pretty: true });

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('refused');
    expect(outcome.steps).toContainEqual(expect.objectContaining({
      step: 'recheck-refresh-rollback-fence-requirement-before-switch', ok: false,
    }));
    expect(world.mutatingCalls()).toEqual([]);
  });

  it('refuses before live switch when the candidate release commit changes after planning', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    const world = new SimulatedLaunchd(fixture);
    const context = await buildActivationContext(world.host(), parseActivationArgs(activationArgs(fixture, ['--apply'])));
    rewriteReleaseManifestCommit(fixture.newRelease, 'd'.repeat(40));

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('refused');
    expect(outcome.steps).toContainEqual(expect.objectContaining({
      step: 'recheck-refresh-rollback-fence-requirement-before-switch', ok: false,
    }));
    expect(world.mutatingCalls()).toEqual([]);
  });

  it('blocks rollback when the target refresh fence drifts after planning', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    writeRefreshRollbackFence(fixture.oldRelease);
    let drifted = false;
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => {
        if (root === fixture.newRelease && !drifted) {
          drifted = true;
          writeFileSync(path.join(fixture.oldRelease, REFRESH_ROLLBACK_FENCE_REL), '{');
        }
        return { status: 200, body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease) };
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'before-instance-stop' });
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('blocks rollback when the target refresh fence bytes change with the same capability', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    writeRefreshRollbackFence(fixture.oldRelease);
    let drifted = false;
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => {
        if (root === fixture.newRelease && !drifted) {
          drifted = true;
          writeRefreshRollbackFence(fixture.oldRelease, { pretty: true });
        }
        return { status: 200, body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease) };
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'before-instance-stop' });
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('blocks rollback when the target refresh fence changes during instance stop', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    writeRefreshRollbackFence(fixture.oldRelease);
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => ({
        status: 200,
        body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease),
      }),
      onInstanceExit: (root, via) => {
        if (root === fixture.newRelease && via === 'bootout') {
          writeFileSync(path.join(fixture.oldRelease, REFRESH_ROLLBACK_FENCE_REL), '{');
        }
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'after-instance-stop' });
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.newRelease, 'deploy', 'whatsoup'));
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('blocks rollback when the target release commit changes during instance stop', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    writeRefreshRollbackFence(fixture.oldRelease);
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => ({
        status: 200,
        body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease),
      }),
      onInstanceExit: (root, via) => {
        if (root === fixture.newRelease && via === 'bootout') {
          rewriteReleaseManifestCommit(fixture.oldRelease, 'e'.repeat(40));
        }
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'after-instance-stop' });
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('rolls back to a compatible sealed target after the new release fails verification', async () => {
    writeRefreshRollbackFence(fixture.newRelease);
    writeRefreshRollbackFence(fixture.oldRelease);
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => ({
        status: 200,
        body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease),
      }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.outcome).toBe('rolled-back');
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(2);
  });

  it('blocks automatic rollback before stop to a target with the a804bb2a fence that lacks the stalled-operation hold', async () => {
    writeRefreshRollbackFenceRaw(fixture.newRelease, SHIPPED_REFRESH_FENCE);
    writeRefreshRollbackFenceRaw(fixture.oldRelease, A804BB2A_REFRESH_FENCE);

    const plan = await run(new SimulatedLaunchd(fixture), activationArgs(fixture));
    expect(plan.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(plan.json.rollbackRefreshFence).toMatchObject({
      candidateRequirement: { claudeRefreshOwnerV3: 3, stalledOperationHoldV1: 1 },
      targetCapabilityAtPlan: { claudeRefreshOwnerV3: 3, stalledOperationHoldV1: 0 },
      targetCompatibleAtPlan: false,
    });

    const world = failingNewReleaseWorld();
    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.outcome).toBe('rollback-blocked-refresh-fence');
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'before-instance-stop' });
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.newRelease, 'deploy', 'whatsoup'));
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('blocks automatic rollback before stop when the target refresh fence names an unknown key', async () => {
    writeRefreshRollbackFenceRaw(fixture.newRelease, SHIPPED_REFRESH_FENCE);
    const levels = { claudeRefreshOwnerV3: 3, stalledOperationHoldV1: 1, unknownFenceV1: 1 };
    writeRefreshRollbackFenceRaw(fixture.oldRelease, JSON.stringify({
      schemaVersion: 1,
      activationRequirements: { rollbackTarget: levels },
      rollbackCapabilities: levels,
    }));
    const world = failingNewReleaseWorld();

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(5);
    expect(result.json.outcome).toBe('rollback-blocked-refresh-fence');
    expect(result.json.rollback).toMatchObject({ refreshFenceBlockedAt: 'before-instance-stop' });
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('rolls back to a target whose sealed fence provides both the refresh owner and the stalled-operation hold', async () => {
    writeRefreshRollbackFenceRaw(fixture.newRelease, SHIPPED_REFRESH_FENCE);
    writeRefreshRollbackFence(fixture.oldRelease, { holdRequirement: 1, holdCapability: 1 });
    const world = failingNewReleaseWorld();

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.outcome).toBe('rolled-back');
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(2);
  });

  it('refuses before live switch when the candidate stalled-operation hold requirement changes after planning', async () => {
    writeRefreshRollbackFence(fixture.newRelease, { holdRequirement: 1, holdCapability: 1 });
    const world = new SimulatedLaunchd(fixture);
    const context = await buildActivationContext(world.host(), parseActivationArgs(activationArgs(fixture, ['--apply'])));
    writeRefreshRollbackFence(fixture.newRelease, { holdRequirement: 2, holdCapability: 1 });

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('refused');
    expect(outcome.steps).toContainEqual(expect.objectContaining({
      step: 'recheck-refresh-rollback-fence-requirement-before-switch', ok: false,
    }));
    expect(world.mutatingCalls()).toEqual([]);
  });

});
