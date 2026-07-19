#!/usr/bin/env node
// Shared real child fixture for the B1, B2, and X6 lifecycle probes.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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
  const grandchildProgram = config.grandchildrenIgnoreSigterm
    ? "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"
    : 'setInterval(()=>{}, 1000)';
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
  writeFileSync(
    config.pidFile,
    JSON.stringify({ provider: process.pid, g1: g1?.pid ?? null, g2: g2?.pid ?? null }),
  );
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
// never strands its own tree.
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
const orphanTimer = setInterval(() => {
  if (process.ppid === 1) selfExpire();
}, positiveMsOr(1_000, process.env.FAKE_PROVIDER_ORPHAN_POLL_MS));
orphanTimer.unref();

// Hard TTL backstop: far above any legitimate suite run, far below the
// multi-day orphan lifetimes this guards against.
const ttlTimer = setTimeout(
  selfExpire,
  positiveMsOr(30 * 60 * 1_000, process.env.FAKE_PROVIDER_MAX_LIFETIME_MS),
);
ttlTimer.unref();
