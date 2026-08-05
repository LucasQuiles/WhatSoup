import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// test-integrity: source-string-ok — this is a static-policy contract test
// that intentionally pins source text: the boot site's reclaim opt-in and its
// log lines are the policy under test (mini10 crash-loop regression guard).

/**
 * Boot-lock reclaim contract (mini10 ad-bot incident, 2026-08-05; refs #2961).
 *
 * The instance boot lock is held by a supervisor-managed singleton: launchd /
 * systemd kill the whole process group, so a dead holder PID from the current
 * boot cannot leave live children owning the port or database. Without the
 * same-boot opt-in, a SIGKILLed predecessor's lock turns every supervised
 * respawn into `stale` → exit 1 — a crash loop only manual lock removal can
 * break. These assertions pin the boot site's opt-in and its observability so
 * a refactor cannot silently regress the fleet back into that failure mode.
 */
describe('boot lock same-boot reclaim contract', () => {
  const mainSource = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');

  it('the boot lock acquisition opts into dead same-boot reclaim', () => {
    // String anchors only — sentinel fallbacks make a vanished site fail the
    // assertions below instead of passing vacuously.
    const fnStart = mainSource.indexOf('function acquireLock');
    const callStart = fnStart === -1 ? -1 : mainSource.indexOf('config.lockPath', fnStart);
    const beforeCall = fnStart === -1 || callStart === -1
      ? 'BOOT-LOCK-CALL-SITE-NOT-FOUND'
      : mainSource.slice(fnStart, callStart);
    const callSnippet = callStart === -1
      ? 'BOOT-LOCK-CALL-SITE-NOT-FOUND'
      : mainSource.slice(callStart, callStart + 120);
    expect(beforeCall).toContain('acquireProcessLock');
    expect(callSnippet).toContain('reclaimDeadSameBoot: true');
  });

  it('a same-boot reclaim is logged distinctly from a reboot reclaim', () => {
    expect(mainSource).toContain('reclaimedDeadSameBoot');
    expect(mainSource).toContain('dead same-boot predecessor');
    // The reboot self-heal log must survive alongside the new one.
    expect(mainSource).toContain('reclaimedPreviousBoot');
    expect(mainSource).toContain('previous boot');
  });

  it('the lock library still fails closed by default (opt-in is not the default)', () => {
    const libSource = readFileSync(join(process.cwd(), 'src', 'lib', 'process-lock.ts'), 'utf8');
    // The option must remain optional with no default-true anywhere: the only
    // way reclaimDeadSameBoot influences the reclaim decision is an explicit
    // strict-equality check against true at the call's option object.
    expect(libSource).toContain('options.reclaimDeadSameBoot === true');
    expect(libSource).not.toContain('reclaimDeadSameBoot = true');
    expect(libSource).not.toContain('reclaimDeadSameBoot ?? true');
  });
});
