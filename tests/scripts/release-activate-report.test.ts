/**
 * #2481: the report phase of release:activate (binding, receipt, event)
 * against the simulated launchd world (tests/helpers/release-activate-world.ts).
 * The report never changes the activation outcome or exit code, binds a body
 * only to a process that started before the request, and states the
 * warn/clear rule exactly. All identifiers are fabricated.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** node:fs passes through unchanged unless a test sets a hook. */
const fsFaults = vi.hoisted(() => ({
  opened: new Map<number, string>(),
  /** Runs after openSync with the opened path. */
  onOpen: null as null | ((openedPath: string) => void),
  /** Runs before fsyncSync with the path its fd was opened on (a directory fsync opens the directory). */
  fsync: null as null | ((openedPath: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fsFaults.opened.set(fd, String(args[0]));
      fsFaults.onOpen?.(String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      fsFaults.fsync?.(fsFaults.opened.get(fd) ?? '');
      return actual.fsyncSync(fd);
    },
  };
});

/** The report phase's first step fails when a test sets this (a fault the host seams cannot inject). */
const applyFaults = vi.hoisted(() => ({ bindings: null as null | (() => Error) }));

vi.mock('../../scripts/lib/release-activation/apply.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/release-activation/apply.ts')>();
  return {
    ...actual,
    resolveOutcomeBindings: (...args: Parameters<typeof actual.resolveOutcomeBindings>) => {
      const fault = applyFaults.bindings?.();
      return fault ? Promise.reject(fault) : actual.resolveOutcomeBindings(...args);
    },
  };
});

import { RELEASE_ACTIVATE_EXIT, runReleaseActivateCli } from '../../scripts/release-activate.ts';
import {
  activationArgs,
  type Fixture,
  FIXTURE_SCHEMA,
  installFixture,
  INSTANCE,
  migrateFixture,
  onlyBackup,
  run,
  SimulatedLaunchd,
  TIMER_LABEL,
} from '../helpers/release-activate-world.ts';

let fixture: Fixture;

beforeEach(() => {
  fixture = installFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fsFaults.onOpen = null;
  fsFaults.fsync = null;
  applyFaults.bindings = null;
});

function receiptOf(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(onlyBackup(fixture), 'receipt.json'), 'utf8')) as Record<string, unknown>;
}

/** Replace the backup directory with a plain file, so the next receipt write fails. */
function blockBackupDir(): { restore: () => void } {
  const dir = onlyBackup(fixture);
  const aside = `${dir}.aside`;
  renameSync(dir, aside);
  writeFileSync(dir, 'not a directory\n');
  return {
    restore: () => {
      unlinkSync(dir);
      renameSync(aside, dir);
    },
  };
}

/** One sample after the outcome: exactly one bounded launchctl print and one start-time read. */
function expectOneSample(world: SimulatedLaunchd): void {
  expect(world.boundedCalls.filter(([file, verb]) => file === 'launchctl' && verb === 'print')).toHaveLength(1);
  expect(world.boundedCalls.filter((call) => call.includes('lstart='))).toHaveLength(1);
}

describe('release:activate report: the binding boundary is taken before the request (#2481)', () => {
  it('a delayed response never binds the process that reused its pid: request, answer and exit, reuse, then the read', async () => {
    const seen: { requestAt?: number } = {};
    let world: SimulatedLaunchd | null = null;
    // The tool reads the response 2.1 s after it was served (descheduled, or buffered socket data).
    world = new SimulatedLaunchd(fixture, {
      responseDelayMs: 2_100,
      health: (root, fallback) => {
        const response = fallback();
        if (root === fixture.newRelease && seen.requestAt === undefined) {
          seen.requestAt = world!.now();
          // The responder answers and exits; a process with the same argv reuses its pid 0.9 s after the request.
          world!.reuseInstancePid(seen.requestAt + 900);
        }
        return response;
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    // Fixture premise: the replacement started after the request, in an earlier second than the tool read the response.
    expect(seen.requestAt).toBeTypeOf('number');
    const requestAt = seen.requestAt as number;
    expect(world.instanceStartedAt()).toBe(requestAt + 900);
    expect(Math.floor((requestAt + 900) / 1_000)).toBeLessThan(Math.floor((requestAt + 2_100) / 1_000));
    expect(receiptOf().verification).toMatchObject({ binding: expect.stringMatching(/^(restarted|unobserved)$/) });
    expect(receiptOf().invariants).toMatchObject({ activation: { outcome: 'unknown' } });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('a responder that started well before the request binds, even when its response is read late: one clear', async () => {
    const world = new SimulatedLaunchd(fixture, { bootMs: 60_000, responseDelayMs: 2_100 });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().verification).toMatchObject({ binding: 'bound' });
    expect(receiptOf().invariants).toMatchObject({ activation: { outcome: 'satisfied' } });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['clear']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });
});

describe('release:activate report: one exception boundary, and a clock read that cannot move verification (#2481)', () => {
  it('a throw in the report phase after a successful activation returns exit 0 with one fixed stderr line, no message or path', async () => {
    applyFaults.bindings = () => new Error(`injected report fault under ${fixture.base}`);
    const world = new SimulatedLaunchd(fixture);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.stderr).toBe('release:activate: report-failed Error\n');
  });

  it('a stderr callback that throws while reporting a receipt failure still returns the fixed exit code', async () => {
    let blocked: { restore: () => void } | null = null;
    const world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => {
        // Verification runs after every backup write, so the receipt is the next write into the directory.
        if (root === fixture.newRelease && blocked === null) blocked = blockBackupDir();
        return fallback();
      },
    });
    let stderrCalls = 0;

    const code = await runReleaseActivateCli(activationArgs(fixture, ['--apply']), world.host(), {
      stdout: () => {},
      stderr: () => {
        stderrCalls += 1;
        throw new Error('stderr closed');
      },
    });
    (blocked as { restore: () => void } | null)?.restore();

    expect(stderrCalls).toBeGreaterThan(0);
    expect(code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a clock that throws in a verification poll never discards the health body: baseline outcome, exit and poll, binding unobserved', async () => {
    // The poll's clock read (the one right after its argv read) throws once per poll.
    const world = new SimulatedLaunchd(fixture, { clockFaultAfterArgvRead: true });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(world.clockFaults).toBe(1);
    expect(world.served.filter((entry) => entry.root === fixture.newRelease)).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
    expect(receiptOf().verification).toMatchObject({ binding: 'unobserved' });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
  });
});

describe('release:activate report: the warn/clear rule after an auxiliary-label failure (#2481)', () => {
  // The timer label still names the old release after the switch: the instance passes, the aux check fails.
  const staleTimer = (label: string, definition: string): string => (label === TIMER_LABEL
    ? definition.replaceAll(`${fixture.newRelease}/`, `${fixture.oldRelease}/`)
    : definition);

  it('a completed rollback restarts the instance: the passed activation reads restarted, one warning, one sample', async () => {
    const world = new SimulatedLaunchd(fixture, { auxDefinition: staleTimer });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.outcome).toBe('rolled-back');
    expect(receiptOf().verification).toMatchObject({ binding: 'restarted' });
    expect(receiptOf().rollback).toMatchObject({ observation: { binding: 'bound' } });
    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unbound' },
      rollback: { outcome: 'satisfied' },
      alert: { attempted: true, kind: 'warning', status: 0 },
    });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    // Both observations passed, and still one shared sample.
    expectOneSample(world);
  });

  it('a rollback blocked before it touched the instance leaves it bound and satisfied: no event, one sample', async () => {
    const world = new SimulatedLaunchd(fixture, {
      auxDefinition: staleTimer,
      // The new release migrates at startup, so the schema gate blocks the rollback before it stops anything.
      onInstanceStart: (root) => {
        if (root === fixture.newRelease) migrateFixture(fixture.dbPath, FIXTURE_SCHEMA + 1);
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    expect(result.json.schemaMigration).toMatchObject({ blockedAt: 'before-rollback' });
    expect(receiptOf().verification).toMatchObject({ binding: 'bound' });
    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied' },
      rollback: null,
      alert: { attempted: false, kind: null, status: null },
    });
    expect(world.alerts).toEqual([]);
    expectOneSample(world);
  });
});

describe('release:activate report: one directory fsync per receipt write (#2481)', () => {
  it('a would-be second directory fsync that fails never reports durability unproven', async () => {
    // Directory fsyncs of the backup directory, counted per receipt write (a write starts at its temporary file).
    const perWrite: number[] = [];
    const world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => {
        if (root === fixture.newRelease && fsFaults.fsync === null) {
          const dir = onlyBackup(fixture);
          fsFaults.onOpen = (openedPath) => {
            if (path.basename(openedPath).startsWith('.receipt.json.')) perWrite.push(0);
          };
          fsFaults.fsync = (openedPath) => {
            if (openedPath !== dir || perWrite.length === 0) return;
            const index = perWrite.length - 1;
            perWrite[index] = (perWrite[index] ?? 0) + 1;
            if (perWrite[index] === 2) throw Object.assign(new Error('EIO: injected second directory fsync'), { code: 'EIO' });
          };
        }
        return fallback();
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));
    fsFaults.onOpen = null;
    fsFaults.fsync = null;

    // Two writes (pending, then the event status), each with exactly one directory fsync.
    expect(perWrite).toEqual([1, 1]);
    expect(result.stderr).not.toContain('durability-unproven');
    expect(receiptOf().invariants).toMatchObject({ alert: { attempted: true, kind: 'clear', status: 0 } });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });
});
