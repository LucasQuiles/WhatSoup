import { describe, expect, it } from 'vitest';
import { SessionOwnershipRegistry } from '../../../src/runtimes/agent/session-ownership.ts';
import type { SessionManager } from '../../../src/runtimes/agent/session.ts';
import {
  buildManager,
  isAlive,
  killPid,
  makeMemoryDb,
  makeMessenger,
  waitUntil,
} from './lib/session-harness.ts';

interface InspectableSessionManager {
  child: {
    stdout: { emit(event: 'data', chunk: Buffer): boolean };
    stderr: { emit(event: 'data', chunk: Buffer): boolean };
  } | null;
  crashStderrPreview: string;
}

function bindOwnership(
  mgr: SessionManager,
  registry: SessionOwnershipRegistry,
  managerId: string,
  currentMapKey: () => string,
): void {
  mgr.bindGenerationOwnership(() => {
    const mapKey = currentMapKey();
    const owner = registry.get(mapKey);
    if (!owner || !registry.isCurrent(mapKey, managerId, owner.generation)) return null;
    return { managerId, generation: owner.generation };
  });
}

describe('persistent child generation ownership', () => {
  it('SIGKILLs a stubborn superseded child after a replacement generation spawns', async () => {
    const runId = `l4stubborn${Date.now().toString(36)}${process.pid}`;
    const mapKey = `${runId}@s.whatsapp.net`;
    const managerId = `manager-${runId}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const registry = new SessionOwnershipRegistry();
    const { mgr } = buildManager({
      db,
      messenger,
      chatJid: mapKey,
      fakeConfig: {
        runId,
        sessionId: runId,
        ignoreSigterm: true,
      },
    });
    registry.claim(mapKey, managerId);
    bindOwnership(mgr, registry, managerId, () => mapKey);
    const shutdownGraceMs = (
      mgr.constructor as unknown as { SHUTDOWN_GRACE_MS: number }
    ).SHUTDOWN_GRACE_MS;
    let oldPid = 0;
    let newPid = 0;

    try {
      await mgr.spawnSession();
      await waitUntil(() => mgr.getStatus().sessionId === `${runId}-gen1`, 6_000);
      oldPid = mgr.getStatus().pid ?? 0;

      registry.advanceGeneration(mapKey, managerId);
      await mgr.handleNew();
      await waitUntil(() => mgr.getStatus().sessionId === `${runId}-gen2`, 6_000);
      newPid = mgr.getStatus().pid ?? 0;

      const oldChildExited = await waitUntil(
        () => !isAlive(oldPid),
        shutdownGraceMs + 1_500,
      );
      expect(
        oldChildExited,
        `old child alive after escalation window: superseded pid ${oldPid}, replacement pid ${newPid}`,
      ).toBe(true);
    } finally {
      await mgr.shutdown(false);
      killPid(oldPid);
      killPid(newPid);
      await waitUntil(() => !isAlive(oldPid) && !isAlive(newPid), 1_500);
      db.close();
    }
  }, 30_000);

  it('B1(c): a late init from the superseded old child must NOT clobber the new generation', async () => {
    const runId = `b1${Date.now().toString(36)}${process.pid}`;
    const lateValue = `AUDIT_B1_LATE_${runId}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const mapKey = `${runId}@s.whatsapp.net`;
    const managerId = `manager-${runId}`;
    const registry = new SessionOwnershipRegistry();
    const { mgr } = buildManager({
      db,
      messenger,
      chatJid: mapKey,
      fakeConfig: {
        runId,
        sessionId: `b1-${runId}`,
        lateSessionId: lateValue,
        graceMs: 300,
      },
    });
    registry.claim(mapKey, managerId);
    bindOwnership(mgr, registry, managerId, () => mapKey);
    let oldPid = 0;
    let newPid = 0;

    try {
      await mgr.spawnSession();
      await waitUntil(() => mgr.getStatus().sessionId === `b1-${runId}-gen1`, 6_000);
      oldPid = mgr.getStatus().pid ?? 0;

      registry.advanceGeneration(mapKey, managerId);
      await mgr.handleNew();
      await waitUntil(() => mgr.getStatus().sessionId === `b1-${runId}-gen2`, 6_000);
      newPid = mgr.getStatus().pid ?? 0;

      const clobbered = await waitUntil(() => mgr.getStatus().sessionId === lateValue, 1_500);
      const liveSessionId = mgr.getStatus().sessionId;
      const newestRow = db.raw
        .prepare('SELECT id, session_id FROM agent_sessions ORDER BY id DESC LIMIT 1')
        .get() as { id: number; session_id: string | null } | undefined;
      const assertionMessage =
        `B1(c): superseded old child (pid ${oldPid}) late init "${lateValue}" ` +
        `clobbered new-generation live sessionId (now "${liveSessionId}") and DB row ` +
        `${newestRow?.id} — off-map orphan still mutates live state`;

      expect(clobbered, assertionMessage).toBe(false);
      expect(
        newestRow?.session_id,
        'B1(c)-db: new-generation DB row session_id was overwritten by the superseded old child',
      ).toBe(`b1-${runId}-gen2`);
    } finally {
      await mgr.shutdown(false);
      killPid(oldPid);
      killPid(newPid);
      await waitUntil(() => !isAlive(oldPid) && !isAlive(newPid), 1_500);
      db.close();
    }
  }, 30_000);

  it('drops old-generation stdout even while the same child identity is attached', async () => {
    const runId = `b1generation${Date.now().toString(36)}${process.pid}`;
    const mapKey = `${runId}@s.whatsapp.net`;
    const managerId = `manager-${runId}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const registry = new SessionOwnershipRegistry();
    const { mgr } = buildManager({
      db,
      messenger,
      chatJid: mapKey,
      fakeConfig: { runId, sessionId: runId },
    });
    registry.claim(mapKey, managerId);
    bindOwnership(mgr, registry, managerId, () => mapKey);
    let pid = 0;

    try {
      await mgr.spawnSession();
      await waitUntil(() => mgr.getStatus().sessionId === `${runId}-gen1`, 6_000);
      pid = mgr.getStatus().pid ?? 0;
      const attachedChild = (mgr as unknown as InspectableSessionManager).child;
      expect(attachedChild).not.toBeNull();

      registry.advanceGeneration(mapKey, managerId);
      attachedChild!.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'STALE_GENERATION' })}\n`),
      );

      expect(mgr.getStatus().sessionId).toBe(`${runId}-gen1`);
      const row = db.raw
        .prepare('SELECT session_id FROM agent_sessions ORDER BY id DESC LIMIT 1')
        .get() as { session_id: string | null } | undefined;
      expect(row?.session_id).toBe(`${runId}-gen1`);
    } finally {
      await mgr.shutdown(false);
      killPid(pid);
      await waitUntil(() => !isAlive(pid), 1_500);
      db.close();
    }
  }, 30_000);

  it('keeps the current child generation valid after its owner is rekeyed', async () => {
    const runId = `b1rekey${Date.now().toString(36)}${process.pid}`;
    let mapKey = `${runId}@lid`;
    const canonicalMapKey = `${runId}@s.whatsapp.net`;
    const managerId = `manager-${runId}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const registry = new SessionOwnershipRegistry();
    const { mgr } = buildManager({
      db,
      messenger,
      chatJid: mapKey,
      fakeConfig: { runId, sessionId: runId },
    });
    registry.claim(mapKey, managerId);
    bindOwnership(mgr, registry, managerId, () => mapKey);
    let pid = 0;

    try {
      await mgr.spawnSession();
      await waitUntil(() => mgr.getStatus().sessionId === `${runId}-gen1`, 6_000);
      pid = mgr.getStatus().pid ?? 0;
      const attachedChild = (mgr as unknown as InspectableSessionManager).child;
      expect(attachedChild).not.toBeNull();

      registry.rekey(mapKey, canonicalMapKey, managerId);
      mapKey = canonicalMapKey;
      attachedChild!.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'REKEYED_CURRENT' })}\n`),
      );

      expect(mgr.getStatus().sessionId).toBe('REKEYED_CURRENT');
      expect(registry.isCurrent(canonicalMapKey, managerId, 1)).toBe(true);
    } finally {
      await mgr.shutdown(false);
      killPid(pid);
      await waitUntil(() => !isAlive(pid), 1_500);
      db.close();
    }
  }, 30_000);

  it('drops superseded child stderr before it mutates the current crash preview', async () => {
    const runId = `b1stderr${Date.now().toString(36)}${process.pid}`;
    const mapKey = `${runId}@s.whatsapp.net`;
    const managerId = `manager-${runId}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const registry = new SessionOwnershipRegistry();
    const { mgr } = buildManager({
      db,
      messenger,
      chatJid: mapKey,
      fakeConfig: { runId, sessionId: runId, graceMs: 300 },
    });
    registry.claim(mapKey, managerId);
    bindOwnership(mgr, registry, managerId, () => mapKey);
    let oldPid = 0;
    let newPid = 0;

    try {
      await mgr.spawnSession();
      await waitUntil(() => mgr.getStatus().sessionId === `${runId}-gen1`, 6_000);
      oldPid = mgr.getStatus().pid ?? 0;
      const oldChild = (mgr as unknown as InspectableSessionManager).child;
      expect(oldChild).not.toBeNull();

      registry.advanceGeneration(mapKey, managerId);
      await mgr.handleNew();
      await waitUntil(() => mgr.getStatus().sessionId === `${runId}-gen2`, 6_000);
      newPid = mgr.getStatus().pid ?? 0;
      oldChild!.stderr.emit('data', Buffer.from('STALE_STDERR_PREVIEW'));

      expect((mgr as unknown as InspectableSessionManager).crashStderrPreview).toBe('');
    } finally {
      await mgr.shutdown(false);
      killPid(oldPid);
      killPid(newPid);
      await waitUntil(() => !isAlive(oldPid) && !isAlive(newPid), 1_500);
      db.close();
    }
  }, 30_000);
});
