#!/usr/bin/env node
// Shared real child fixture for the B1, B2, and X6 lifecycle probes.
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { isOrphaned } from './orphan-predicate.ts';

const config = JSON.parse(process.argv[2] ?? '{}');
const runId = config.runId ?? 'unknown';
const sessionId = config.sessionId ?? `probe-${runId}`;
const graceMs = Number(config.graceMs ?? 200);

function emitInit(id) {
  try {
    const event = config.protocol === 'opencode'
      ? { type: 'step_start', sessionID: id }
      : { type: 'system', subtype: 'init', session_id: id };
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    // Teardown may close stdout before a deliberately late lifecycle event.
  }
}

emitInit(sessionId);

let g1 = null;
let g2 = null;
if (config.spawnGrandchildren) {
  // B25 2b: TTL-only backstop for the grandchild programs. If this fixture
  // dies WITHOUT running selfExpire (crashAfterMs / external SIGKILL) while
  // the vitest worker also dies, nothing else ever reaps the SIGTERM-ignoring
  // grandchildren — the exact orphan class the fixture-level self-expiry
  // closes, one level down. TTL ONLY, deliberately NO ppid watch (see the
  // scope note below): the default sits above the fixture's own 30-minute
  // TTL so the reaping suites always observe live grandchildren at test
  // timescales and the fixture's selfExpire stays the primary reaper.
  const grandchildTtlMs = positiveMsOr(35 * 60 * 1_000, process.env.FAKE_PROVIDER_GRANDCHILD_TTL_MS);
  const grandchildTtl = `setTimeout(() => process.exit(0), ${grandchildTtlMs})`;
  const grandchildProgram = config.grandchildrenIgnoreSigterm
    ? `process.on('SIGTERM',()=>{}); ${grandchildTtl}; setInterval(()=>{}, 1000)`
    : `${grandchildTtl}; setInterval(()=>{}, 1000)`;
  const spawnGrandchild = (tag, detached) =>
    spawn(process.execPath, ['-e', grandchildProgram, `AUDIT_X6_${runId}_${tag}`], {
      detached,
      stdio: 'ignore',
    });
  g1 = spawnGrandchild('g1', false);
  g2 = spawnGrandchild('g2', true);
  g2.unref();
}

if (config.pidFile) {
  const tempPidFile = `${config.pidFile}.tmp-${process.pid}`;
  writeFileSync(
    tempPidFile,
    JSON.stringify({ provider: process.pid, g1: g1?.pid ?? null, g2: g2?.pid ?? null }),
    { mode: 0o600 },
  );
  // Tests use existence as the readiness receipt. Publish only after the JSON
  // is complete so readers can never observe the truncate/write window.
  renameSync(tempPidFile, config.pidFile);
}

if (config.handleSigterm !== false) {
  process.on('SIGTERM', () => {
    if (config.ignoreSigterm) return;
    if (config.lateSessionId) {
      setTimeout(() => emitInit(config.lateSessionId), Math.max(10, Math.floor(graceMs / 2)));
    }
    setTimeout(() => process.exit(0), graceMs);
  });
}

if (config.crashAfterMs !== undefined) {
  setTimeout(() => process.exit(config.crashCode ?? 1), Number(config.crashAfterMs));
}

setInterval(() => {}, 1_000);

// --- Fixture self-expiry: orphan watch + TTL backstop (B22) -----------------
// The ignoreSigterm contract is about signals sent BY the harness under test:
// a "stubborn" provider must survive the harness's SIGTERM so escalation paths
// (SIGKILL, process-tree reaping) are actually exercised. Self-expiry is not a
// signal response — it is the fixture noticing that no test owns it any more:
// either its spawning vitest worker died (the fixture reparented to pid 1) or
// it has outlived any plausible suite run. Both paths exit even when
// ignoreSigterm is set; without them a worker crash/kill/recycle before
// teardown strands this process forever (observed: fixtures alive 4+ days).
//
// Scope note: no current test kills this fixture's PARENT deliberately — the
// process-tree reaping probes kill the fixture itself and then assert that
// killSessionTree collects the reparented grandchildren. That is why the
// grandchild `-e` programs above deliberately get NO ppid-watch of their own
// (self-exit there would fake a pass for the reaper), while grandchildren ARE
// reaped here when the fixture itself self-expires, so an expiring fixture
// never strands its own tree. B25 2b adds a TTL-ONLY backstop to the
// grandchild programs (default far above any suite run, so the reaper still
// finds live grandchildren at test timescales) for the one remaining strand
// path: the fixture dying without selfExpire while the worker also dies.
function selfExpire() {
  for (const grandchild of [g1, g2]) {
    if (!grandchild?.pid) continue;
    try {
      process.kill(grandchild.pid, 'SIGKILL');
    } catch {
      // Best effort — the grandchild may already be gone.
    }
  }
  process.exit(0);
}

function positiveMsOr(fallbackMs, raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

// Both timers are unref'd: self-expiry must never keep the fixture alive on
// its own — the keep-alive interval above is the only thing holding the loop.
//
// B25 2a: orphan signal = "ppid CHANGED from its startup value" (see
// orphan-predicate.ts). The old `process.ppid === 1` form was macOS-only in
// practice: under Linux child-subreapers (systemd --user — the fleet's
// Linux deploy-gate environment; docker-init; CI shims) an orphan reparents
// to the subreaper, never to init, so the watch never fired and the TTL was
// the only working backstop there.
const startupPpid = process.ppid;
const orphanTimer = setInterval(() => {
  if (isOrphaned(startupPpid, process.ppid)) selfExpire();
}, positiveMsOr(1_000, process.env.FAKE_PROVIDER_ORPHAN_POLL_MS));
orphanTimer.unref();

// Hard TTL backstop: far above any legitimate suite run, far below the
// multi-day orphan lifetimes this guards against.
const ttlTimer = setTimeout(
  selfExpire,
  positiveMsOr(30 * 60 * 1_000, process.env.FAKE_PROVIDER_MAX_LIFETIME_MS),
);
ttlTimer.unref();
