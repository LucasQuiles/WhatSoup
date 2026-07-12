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
