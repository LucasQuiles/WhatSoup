/**
 * release:activate on Linux (systemd --user) against a simulated systemd world
 * (tests/helpers/release-activate-systemd-world.ts). Every refusal proves exit
 * 2, no daemon-reload/stop/start/restart, and an unchanged drop-in directory.
 * Forward admission and rollback admission are tested apart: an incompatible
 * predecessor alone never blocks the forward switch, only the automatic
 * rollback, and then the switch needs validated recovery evidence.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** node:fs passes through unchanged unless a test sets a hook. */
const fsFaults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => void),
  transformWrite: null as null | ((target: string, data: unknown) => unknown),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      fsFaults.rename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const data = fsFaults.transformWrite === null ? args[1] : fsFaults.transformWrite(String(args[0]), args[1]);
      return actual.writeFileSync(args[0], data as Parameters<typeof actual.writeFileSync>[1], args[2]);
    },
  };
});

/** The consistent backup passes through unless a test fails it before, or corrupts its copy after. */
const backupFaults = vi.hoisted(() => ({
  before: null as null | (() => void),
  after: null as null | ((backupPath: string) => void),
}));

vi.mock('../../scripts/lib/sqlite-consistent-backup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/sqlite-consistent-backup.ts')>();
  return {
    ...actual,
    backupSqliteConsistent: async (source: string, destination: string) => {
      backupFaults.before?.();
      const receipt = await actual.backupSqliteConsistent(source, destination);
      backupFaults.after?.(destination);
      return receipt;
    },
  };
});

import { RELEASE_ACTIVATE_EXIT } from '../../scripts/release-activate.ts';
import {
  diagnosticBody,
  FIXTURE_SCHEMA,
  migrateFixture,
  snapshotTree,
  writeRefreshRollbackFence,
  writeRefreshRollbackFenceRaw,
  writeRelease,
} from '../helpers/release-activate-world.ts';
import {
  failedPreconditions,
  INSIDE_UNIT_CGROUP,
  installSystemdFixture,
  INSTANCE,
  onlySystemdBackup,
  releaseDropIn,
  runSystemd,
  SimulatedSystemd,
  SYS_NEW_COMMIT,
  SYS_OLD_COMMIT,
  type SystemdFixture,
  systemdActivationArgs,
  UNIT,
  writeSchemaSupport,
} from '../helpers/release-activate-systemd-world.ts';
import { nextReleaseDropInName } from '../../scripts/lib/release-activation/systemd.ts';

let fixture: SystemdFixture;
/**
 * The same `z` count as the effective `zzzzzzzz-release-c0ffee044d00.conf`: the
 * new commit `c0ffee0f7a00` already sorts after it, so no extra `z` is needed.
 */
const NEW_DROPIN = `zzzzzzzz-release-${SYS_NEW_COMMIT.slice(0, 12)}.conf`;

beforeEach(() => {
  fixture = installSystemdFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
});

afterEach(() => {
  fsFaults.rename = null;
  fsFaults.transformWrite = null;
  backupFaults.before = null;
  backupFaults.after = null;
  vi.unstubAllEnvs();
});

/** The candidate requires the current fence keys of a rollback target; the legacy predecessor provides level 0. */
function candidateRequiresFence(): void {
  writeRefreshRollbackFence(fixture.newRelease, { holdRequirement: 1, holdCapability: 1 });
}

/** The new release serves a disconnected session, so verification fails after the restart. */
function newReleaseUnhealthy(root: string | null, fallback: () => { status: number; body: string }): { status: number; body: string } {
  return root === fixture.newRelease ? { status: 200, body: diagnosticBody(SYS_NEW_COMMIT, false) } : fallback();
}

async function expectRefusedWithoutLiveChange(
  world: SimulatedSystemd,
  argv: string[],
  expectedFailures: string[] | null,
): Promise<Awaited<ReturnType<typeof runSystemd>>> {
  const before = snapshotTree(fixture.dropInDir);
  const startsBefore = [...world.instanceStarts];
  const result = await runSystemd(world, argv);
  expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
  if (expectedFailures !== null) {
    for (const id of expectedFailures) expect(failedPreconditions(result.json)).toContain(id);
  }
  expect(world.mutatingCalls()).toEqual([]);
  expect(snapshotTree(fixture.dropInDir)).toEqual(before);
  expect(world.instanceStarts).toEqual(startsBefore);
  return result;
}

describe('release:activate systemd --plan', () => {
  it('binds the running generation from all four sources and stages the next drop-in', async () => {
    const world = new SimulatedSystemd(fixture);
    const result = await runSystemd(world, systemdActivationArgs(fixture));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json).toMatchObject({
      manager: 'systemd-user',
      unit: UNIT,
      ready: true,
      generation: {
        releaseRoot: fixture.oldRelease,
        manifestCommit: SYS_OLD_COMMIT,
        effectiveDropIn: { name: path.basename(fixture.effectiveDropIn) },
        dropInRoot: fixture.oldRelease,
        needDaemonReload: false,
        loadedExecStartRoot: fixture.oldRelease,
        mainPid: world.initialMainPid,
        mainPidRoot: fixture.oldRelease,
      },
      newDropIn: { name: NEW_DROPIN },
      automaticRollback: { available: true, route: 'automatic' },
      rollbackRefreshFence: {
        targetCapabilityAtPlan: { claudeRefreshOwnerV3: 0, stalledOperationHoldV1: 0 },
        targetCompatibleAtPlan: true,
      },
      schema: { live: FIXTURE_SCHEMA, candidate: { max: FIXTURE_SCHEMA + 2 }, target: { max: FIXTURE_SCHEMA } },
    });
    expect(world.calls.every(([file, , verb]) => file === 'systemctl' && verb === 'show')).toBe(true);
    expect(world.mutatingCalls()).toEqual([]);
  });

  it('allows a forward plan from a predecessor without a fence file and records manual recovery as the only route', async () => {
    candidateRequiresFence();
    const world = new SimulatedSystemd(fixture);
    const result = await runSystemd(world, systemdActivationArgs(fixture));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json).toMatchObject({
      rollbackRefreshFence: { targetCompatibleAtPlan: false },
      automaticRollback: { available: false, route: 'manual-recovery-only' },
    });
  });

  it('refuses --wrapper-link, which selects nothing under systemd', async () => {
    const world = new SimulatedSystemd(fixture);
    await expectRefusedWithoutLiveChange(world, systemdActivationArgs(fixture, ['--wrapper-link', path.join(fixture.home, 'w')]),
      ['systemd-options-supported']);
  });
});

describe('release:activate systemd forward admission refusals', () => {
  it('refuses an invalid candidate refresh fence (3a)', async () => {
    writeRefreshRollbackFenceRaw(fixture.newRelease, JSON.stringify({ schemaVersion: 1, activationRequirements: { rollbackTarget: { unknownKeyV9: 1 } }, rollbackCapabilities: { unknownKeyV9: 1 } }));
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture), systemdActivationArgs(fixture, ['--apply']),
      ['release-refresh-rollback-fence-valid']);
  });

  it('refuses a downgrade whose candidate is below the fence the running release requires (3a)', async () => {
    writeRefreshRollbackFence(fixture.oldRelease, { requirement: 3, capability: 3, holdRequirement: 1, holdCapability: 1 });
    const result = await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture), systemdActivationArgs(fixture, ['--apply']),
      ['systemd-candidate-meets-fence-in-force']);
    expect(result.json).toMatchObject({ fenceInForce: { ok: false, candidateCapability: { claudeRefreshOwnerV3: 0, stalledOperationHoldV1: 0 } } });
  });

  it('refuses a database schema above what the candidate opens (3b)', async () => {
    writeSchemaSupport(fixture.newRelease, FIXTURE_SCHEMA - 1);
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture), systemdActivationArgs(fixture, ['--apply']),
      ['release-schema-support-covers-database']);
  });

  it('refuses when the candidate schema support cannot be proven (3b, source differs from the sealed file)', async () => {
    writeFileSync(path.join(fixture.newRelease, 'src', 'core', 'database-schema-version.ts'), 'export const CURRENT_SCHEMA_MIGRATION = 999;\n');
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture), systemdActivationArgs(fixture, ['--apply']),
      ['release-schema-support-covers-database']);
  });

  it('refuses when the database schema level cannot be read (3b, unknown)', async () => {
    writeFileSync(fixture.dbPath, 'not a database');
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture), systemdActivationArgs(fixture, ['--apply']),
      ['database-schema-level-readable', 'release-schema-support-covers-database']);
  });
});

describe('release:activate systemd generation binding refusals', () => {
  it('refuses NeedDaemonReload=yes', async () => {
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture, { needDaemonReload: true }),
      systemdActivationArgs(fixture, ['--apply']), ['systemd-unit-reload-clean']);
  });

  it('refuses a MainPID that runs a different release', async () => {
    const other = path.join(fixture.releasesDir, 'WhatSoup-release-c0ffee0bad00');
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture, { initialMainPidRoot: other }),
      systemdActivationArgs(fixture, ['--apply']), ['systemd-main-pid-on-expected-release']);
  });

  it('refuses a loaded ExecStart that names a different release than the drop-in on disk', async () => {
    const other = path.join(fixture.releasesDir, 'WhatSoup-release-c0ffee0bad00');
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture, { loadedExecRoot: other }),
      systemdActivationArgs(fixture, ['--apply']), ['systemd-loaded-unit-on-expected-release']);
  });

  it('refuses an --expect-current that is not the release the effective drop-in selects', async () => {
    const prior = path.join(fixture.releasesDir, 'WhatSoup-release-c0ffee0bad00');
    writeRelease(prior, `c0ffee0bad00${'7'.repeat(28)}`, true);
    const world = new SimulatedSystemd(fixture);
    await expectRefusedWithoutLiveChange(world, ['--instance', INSTANCE, '--release', fixture.newRelease, '--expect-current', prior,
      '--backup-dir', fixture.backupDir, '--apply'], [
      'systemd-effective-dropin-on-expected-release', 'systemd-loaded-unit-on-expected-release', 'systemd-main-pid-on-expected-release',
    ]);
  });

  it('refuses a later loaded drop-in that overrides ExecStart', async () => {
    writeFileSync(path.join(fixture.dropInDir, 'zzzzzzzzzz-local-override.conf'), '[Service]\nExecStart=\nExecStart=/bin/true\n');
    // The process still runs the old release; only the loaded unit now selects the override.
    const world = new SimulatedSystemd(fixture, { initialMainPidRoot: fixture.oldRelease });
    await expectRefusedWithoutLiveChange(world, systemdActivationArgs(fixture, ['--apply']), ['systemd-loaded-unit-on-expected-release']);
  });
});

describe('release:activate systemd --apply cgroup guard (3d)', () => {
  it('refuses --apply from inside the target unit cgroup', async () => {
    const inside = INSIDE_UNIT_CGROUP;
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture, { selfCgroup: inside }),
      systemdActivationArgs(fixture, ['--apply']), ['systemd-apply-outside-target-cgroup']);
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it('refuses --apply when its own cgroup cannot be read', async () => {
    await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture, { selfCgroup: null }),
      systemdActivationArgs(fixture, ['--apply']), ['systemd-apply-outside-target-cgroup']);
  });

  it('still plans from inside the unit and reports it', async () => {
    const inside = INSIDE_UNIT_CGROUP;
    const result = await runSystemd(new SimulatedSystemd(fixture, { selfCgroup: inside }), systemdActivationArgs(fixture));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json).toMatchObject({ cgroup: { insideTarget: true } });
  });
});

describe('release:activate systemd recovery evidence gates the forward switch (3c)', () => {
  const cases: Array<[string, () => void]> = [
    ['the consistent backup throws', () => { backupFaults.before = () => { throw new Error('SQLite backup source must be an existing regular file'); }; }],
    ['the backup quick_check fails', () => { backupFaults.before = () => { throw new Error('SQLite backup quick_check failed: *** in database main ***'); }; }],
    ['the backup fails quick_check on read-back', () => { backupFaults.after = (backup) => { writeFileSync(backup, 'corrupted after backup'); }; }],
    ['recovery.md cannot be written', () => {
      fsFaults.rename = (_from, to) => { if (path.basename(to) === 'recovery.md') throw new Error('injected ENOSPC'); };
    }],
    ['recovery.json names a different generation', () => {
      fsFaults.transformWrite = (target, data) => {
        if (!path.basename(target).startsWith('.recovery.json.activate-')) return data;
        const record = JSON.parse(String(data)) as { generation: { mainPid: number } };
        record.generation.mainPid += 1;
        return `${JSON.stringify(record, null, 2)}\n`;
      };
    }],
  ];

  it.each(cases)('refuses with exit 2 and no daemon-reload, stop or restart when %s (incompatible predecessor)', async (_name, inject) => {
    candidateRequiresFence();
    inject();
    const world = new SimulatedSystemd(fixture);
    const result = await expectRefusedWithoutLiveChange(world, systemdActivationArgs(fixture, ['--apply']), null);
    expect(result.json).toMatchObject({ outcome: 'refused', automaticRollback: { available: false } });
    expect(existsSync(path.join(fixture.dropInDir, NEW_DROPIN))).toBe(false);
  });

  it('refuses when the drop-in backup copy cannot be written', async () => {
    fsFaults.transformWrite = (target, data) => {
      if (target.includes(`${path.sep}dropins${path.sep}`)) throw new Error('injected EIO');
      return data;
    };
    const result = await expectRefusedWithoutLiveChange(new SimulatedSystemd(fixture), systemdActivationArgs(fixture, ['--apply']), null);
    expect(result.json).toMatchObject({ outcome: 'refused' });
  });
});

describe('release:activate systemd --apply', () => {
  it('activates: backup, recovery evidence, drop-in, daemon-reload, restart, verify', async () => {
    const world = new SimulatedSystemd(fixture);
    const result = await runSystemd(world, systemdActivationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(world.mutatingVerbs()).toEqual(['daemon-reload', 'restart']);
    expect(world.mutatingCalls()[1]).toEqual(['systemctl', '--user', 'restart', UNIT]);
    expect(world.instanceStarts).toEqual([fixture.oldRelease, fixture.newRelease]);
    const dropIn = path.join(fixture.dropInDir, NEW_DROPIN);
    expect(readFileSync(dropIn, 'utf8')).toBe(releaseDropIn(fixture.home, fixture.newRelease));
    expect(statSync(dropIn).mode & 0o777).toBe(0o600);
    expect(readFileSync(fixture.effectiveDropIn, 'utf8')).toBe(releaseDropIn(fixture.home, fixture.oldRelease));

    const backup = onlySystemdBackup(fixture);
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    const recovery = JSON.parse(readFileSync(path.join(backup, 'recovery.json'), 'utf8')) as Record<string, unknown>;
    expect(recovery).toMatchObject({
      unit: UNIT,
      backupPath: backup,
      generation: { releaseRoot: fixture.oldRelease, manifestCommit: SYS_OLD_COMMIT, mainPid: world.initialMainPid },
      candidate: { releaseRoot: fixture.newRelease, dropIn: { name: NEW_DROPIN } },
      database: { backupPath: path.join(backup, 'bot.db'), schemaLevel: FIXTURE_SCHEMA, quickCheck: 'ok' },
    });
    const receipt = JSON.parse(readFileSync(path.join(backup, 'receipt.json'), 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      outcome: 'activated',
      manager: 'systemd-user',
      generation: { releaseRoot: fixture.oldRelease, mainPid: world.initialMainPid },
      recovery: { validated: true },
      automaticRollback: { available: true, route: 'automatic' },
    });
  });

  it('switches forward from an incompatible predecessor once recovery evidence validates, recording manual recovery only', async () => {
    candidateRequiresFence();
    const world = new SimulatedSystemd(fixture);
    const result = await runSystemd(world, systemdActivationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json).toMatchObject({
      outcome: 'activated',
      automaticRollback: { available: false, route: 'manual-recovery-only' },
      recovery: { validated: true },
    });
    const backup = onlySystemdBackup(fixture);
    expect(readFileSync(path.join(backup, 'recovery.md'), 'utf8')).toMatch(/Automatic rollback: UNAVAILABLE/);
  });

  it('rolls back automatically when the predecessor may start: remove drop-in, reload, start', async () => {
    const world = new SimulatedSystemd(fixture, { health: newReleaseUnhealthy });
    const result = await runSystemd(world, systemdActivationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json).toMatchObject({ outcome: 'rolled-back', rollback: { verified: true } });
    expect(world.mutatingVerbs()).toEqual(['daemon-reload', 'restart', 'stop', 'daemon-reload', 'start']);
    expect(world.instanceStarts).toEqual([fixture.oldRelease, fixture.newRelease, fixture.oldRelease]);
    expect(existsSync(path.join(fixture.dropInDir, NEW_DROPIN))).toBe(false);
  });

  it('blocks the rollback before any stop or restore when the new release migrated the database, keeping the backup', async () => {
    const world = new SimulatedSystemd(fixture, {
      health: newReleaseUnhealthy,
      onInstanceStart: (root) => { if (root === fixture.newRelease) migrateFixture(fixture.dbPath, FIXTURE_SCHEMA + 1); },
    });
    const result = await runSystemd(world, systemdActivationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    expect(result.json).toMatchObject({
      outcome: 'rollback-blocked-migrated',
      schemaMigration: { before: FIXTURE_SCHEMA, after: FIXTURE_SCHEMA + 1, blockedAt: 'before-rollback' },
    });
    expect(world.mutatingVerbs()).toEqual(['daemon-reload', 'restart']);
    expect(existsSync(path.join(fixture.dropInDir, NEW_DROPIN))).toBe(true);
    const backup = onlySystemdBackup(fixture);
    for (const file of ['bot.db', 'recovery.json', 'recovery.md', `dropins/${path.basename(fixture.effectiveDropIn)}`]) {
      expect(existsSync(path.join(backup, file))).toBe(true);
    }
    expect(result.stderr).toMatch(/ROLLBACK BLOCKED/);
    expect(result.stderr).toContain(path.join(backup, 'recovery.md'));
    expect(result.stderr).toContain(`systemctl --user stop ${UNIT}`);
    expect(result.stderr).toContain(`cp ${path.join(backup, 'bot.db')} ${fixture.dbPath}`);
  });

  it('never starts a predecessor that fails the candidate fence: refuses before stop and restore (exit 5)', async () => {
    candidateRequiresFence();
    const world = new SimulatedSystemd(fixture, { health: newReleaseUnhealthy });
    const result = await runSystemd(world, systemdActivationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedRefreshFence);
    expect(result.json).toMatchObject({
      outcome: 'rollback-blocked-refresh-fence',
      rollback: { refreshFenceBlockedAt: 'before-instance-stop' },
      automaticRollback: { available: false },
    });
    expect(world.mutatingVerbs()).toEqual(['daemon-reload', 'restart']);
    expect(world.instanceStarts).toEqual([fixture.oldRelease, fixture.newRelease]);
    expect(existsSync(path.join(fixture.dropInDir, NEW_DROPIN))).toBe(true);
    expect(existsSync(path.join(onlySystemdBackup(fixture), 'recovery.md'))).toBe(true);
  });

  it('never starts a predecessor whose schema support is unproven: blocks before stop', async () => {
    unlinkSync(path.join(fixture.oldRelease, 'src', 'core', 'database-schema-version.ts'));
    const world = new SimulatedSystemd(fixture, { health: newReleaseUnhealthy });
    const plan = await runSystemd(new SimulatedSystemd(fixture), systemdActivationArgs(fixture));
    expect(plan.json).toMatchObject({ automaticRollback: { available: false } });
    const result = await runSystemd(world, systemdActivationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    expect(world.mutatingVerbs()).toEqual(['daemon-reload', 'restart']);
    expect(existsSync(path.join(fixture.dropInDir, NEW_DROPIN))).toBe(true);
  });
});

describe('nextReleaseDropInName', () => {
  it('keeps the current z count when the new commit already sorts after the effective drop-in', () => {
    expect(nextReleaseDropInName('c1e24d33a691', ['max-sessions.conf', 'zzzzzzzz-release-44d38619ae4c.conf']))
      .toBe('zzzzzzzz-release-c1e24d33a691.conf');
  });

  it('adds a z when the new commit would sort before the effective drop-in', () => {
    expect(nextReleaseDropInName('44d38619ae4c', ['zzzzzzzz-release-c1e24d33a691.conf']))
      .toBe('zzzzzzzzz-release-44d38619ae4c.conf');
  });

  it('sorts after a later non-release drop-in too', () => {
    expect(nextReleaseDropInName('c1e24d33a691', ['zzzzzzzz-release-44d38619ae4c.conf', 'zzzzzzzzzz-local-override.conf']))
      .toBe('zzzzzzzzzz-release-c1e24d33a691.conf');
    expect(nextReleaseDropInName('c1e24d33a691', ['zzzzzzzzzz-zz-override.conf']))
      .toBe('zzzzzzzzzzz-release-c1e24d33a691.conf');
  });

  it('returns null when 64 z characters cannot sort last', () => {
    expect(nextReleaseDropInName('c1e24d33a691', [`${'z'.repeat(65)}.conf`])).toBeNull();
  });
});
