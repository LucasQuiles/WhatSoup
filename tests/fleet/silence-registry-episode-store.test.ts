import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSilenceRegistryEpisodeStore,
  SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS,
  silenceRegistryEpisodeFailoverPath,
  silenceRegistryEpisodePath,
} from '../../src/fleet/silence-registry-episode-store.ts';

let stateRoot: string;
let statePath: string;

describe('silence-registry episode store', () => {
  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'whatsoup-silence-episode-'));
    chmodSync(stateRoot, 0o700);
    statePath = silenceRegistryEpisodePath(stateRoot);
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('persists one onset and one recovery lifecycle across restarted pollers', () => {
    const firstProcess = createSilenceRegistryEpisodeStore(statePath);
    const onset = firstProcess.prepareOnset({ reasonClass: 'invalid_json', readBasis: 'none' });
    expect(onset).toMatchObject({ status: 'available', action: 'emit_onset' });
    if (onset.status !== 'available' || onset.action !== 'emit_onset') {
      throw new Error('expected an onset emission claim');
    }
    expect(firstProcess.confirmOnset(onset.episodeId)).toEqual({ status: 'available', settled: true });

    const restarted = createSilenceRegistryEpisodeStore(statePath);
    expect(restarted.read()).toMatchObject({ status: 'available', phase: 'open' });
    expect(restarted.prepareOnset({ reasonClass: 'invalid_json', readBasis: 'none' }))
      .toEqual({ status: 'available', action: 'suppressed' });

    const recovery = restarted.prepareRecovery();
    expect(recovery).toMatchObject({ status: 'available', action: 'emit_recovery' });
    if (recovery.status !== 'available' || recovery.action !== 'emit_recovery') {
      throw new Error('expected a recovery emission claim');
    }
    expect(restarted.confirmRecovery(recovery.episodeId)).toEqual({ status: 'available', settled: true });

    const recoveredRestart = createSilenceRegistryEpisodeStore(statePath);
    expect(recoveredRestart.read()).toMatchObject({ status: 'available', phase: 'closed' });
    expect(recoveredRestart.prepareRecovery()).toEqual({ status: 'available', action: 'suppressed' });
  });

  it('retries only a stranded pending transition and preserves an unreadable sticky ledger', () => {
    const store = createSilenceRegistryEpisodeStore(statePath);
    const at = 1_000_000;
    const onset = store.prepareOnset({ reasonClass: 'permission_denied', readBasis: 'none' }, at);
    expect(onset).toMatchObject({ status: 'available', action: 'emit_onset' });
    expect(store.prepareOnset({ reasonClass: 'permission_denied', readBasis: 'none' }, at + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS - 1))
      .toEqual({ status: 'available', action: 'suppressed' });
    const retry = store.prepareOnset(
      { reasonClass: 'permission_denied', readBasis: 'none' },
      at + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS,
    );
    expect(retry).toMatchObject({ status: 'available', action: 'emit_onset' });
    if (onset.status !== 'available' || onset.action !== 'emit_onset') {
      throw new Error('expected an onset emission claim');
    }
    expect(retry).toMatchObject({ episodeId: onset.episodeId });

    const failoverPath = silenceRegistryEpisodeFailoverPath(stateRoot);
    const malformed = '{private-registry-episode-failover-marker';
    writeFileSync(failoverPath, malformed, { mode: 0o600 });
    chmodSync(failoverPath, 0o600);
    const unreadable = createSilenceRegistryEpisodeStore(statePath);
    expect(unreadable.read()).toEqual({ status: 'journal_unreadable' });
    expect(unreadable.prepareOnset({ reasonClass: 'permission_denied', readBasis: 'none' }))
      .toEqual({ status: 'journal_unreadable' });
    expect(readFileSync(failoverPath, 'utf8')).toBe(malformed);
  });

  it('retries pending onset and recovery immediately after a restarted clock rollback', () => {
    const beforeRollback = 2_000_000;
    const afterRollback = beforeRollback - 60_000;
    const first = createSilenceRegistryEpisodeStore(statePath);
    const initialOnset = first.prepareOnset(
      { reasonClass: 'read_failed', readBasis: 'none' },
      beforeRollback,
    );
    expect(initialOnset).toMatchObject({ status: 'available', action: 'emit_onset' });
    if (initialOnset.status !== 'available' || initialOnset.action !== 'emit_onset') {
      throw new Error('expected an onset emission claim');
    }

    const afterOnsetRollback = createSilenceRegistryEpisodeStore(statePath);
    const retriedOnset = afterOnsetRollback.prepareOnset(
      { reasonClass: 'read_failed', readBasis: 'none' },
      afterRollback,
    );
    expect(retriedOnset).toMatchObject({
      status: 'available',
      action: 'emit_onset',
      episodeId: initialOnset.episodeId,
    });
    expect(afterOnsetRollback.confirmOnset(initialOnset.episodeId, afterRollback))
      .toEqual({ status: 'available', settled: true });

    const initialRecovery = afterOnsetRollback.prepareRecovery(beforeRollback);
    expect(initialRecovery).toMatchObject({
      status: 'available',
      action: 'emit_recovery',
      episodeId: initialOnset.episodeId,
    });

    const afterRecoveryRollback = createSilenceRegistryEpisodeStore(statePath);
    expect(afterRecoveryRollback.prepareRecovery(afterRollback)).toMatchObject({
      status: 'available',
      action: 'emit_recovery',
      episodeId: initialOnset.episodeId,
    });
  });

  it('fails closed for a calendar-invalid primary journal timestamp', () => {
    writeFileSync(statePath, `${JSON.stringify({
      v: 1,
      phase: 'open',
      episodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-02-30T00:00:00.000Z',
      reasonClass: 'invalid_json',
      readBasis: 'none',
      recoveryFrom: null,
    })}\n`, { mode: 0o600 });
    chmodSync(statePath, 0o600);

    const store = createSilenceRegistryEpisodeStore(statePath);
    expect(store.read()).toEqual({ status: 'journal_unreadable' });
    expect(store.prepareRecovery()).toEqual({ status: 'journal_unreadable' });
  });

  it('fails closed for a calendar-invalid sticky failover journal timestamp', () => {
    const failoverPath = silenceRegistryEpisodeFailoverPath(stateRoot);
    writeFileSync(failoverPath, `${JSON.stringify({
      v: 1,
      owner: 'failover',
      phase: 'open',
      episodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      updatedAt: '2026-02-30T00:00:00.000Z',
      reasonClass: 'invalid_json',
      readBasis: 'none',
      recoveryFrom: null,
    })}\n`, { mode: 0o600 });
    chmodSync(failoverPath, 0o600);

    const store = createSilenceRegistryEpisodeStore(statePath);
    expect(store.read()).toEqual({ status: 'journal_unreadable' });
    expect(store.prepareRecovery()).toEqual({ status: 'journal_unreadable' });
  });

  it('uses a sticky failover lifecycle when the primary journal is unreadable', () => {
    const malformedPrimary = '{unreadable-primary-episode';
    writeFileSync(statePath, malformedPrimary, { mode: 0o600 });
    chmodSync(statePath, 0o600);
    const first = createSilenceRegistryEpisodeStore(statePath);
    const onset = first.prepareOnset({ reasonClass: 'invalid_json', readBasis: 'none' }, 10_000);
    expect(onset).toMatchObject({ status: 'available', action: 'emit_onset' });
    if (onset.status !== 'available' || onset.action !== 'emit_onset') {
      throw new Error('expected a failover onset emission claim');
    }
    expect(readFileSync(statePath, 'utf8')).toBe(malformedPrimary);
    expect(JSON.parse(readFileSync(silenceRegistryEpisodeFailoverPath(stateRoot), 'utf8')))
      .toMatchObject({ owner: 'failover', phase: 'onset_pending', episodeId: onset.episodeId });

    const pendingRestart = createSilenceRegistryEpisodeStore(statePath);
    expect(pendingRestart.prepareOnset(
      { reasonClass: 'invalid_json', readBasis: 'none' },
      10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS - 1,
    )).toEqual({ status: 'available', action: 'suppressed' });
    const retriedOnset = pendingRestart.prepareOnset(
      { reasonClass: 'invalid_json', readBasis: 'none' },
      10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS,
    );
    expect(retriedOnset).toMatchObject({
      status: 'available',
      action: 'emit_onset',
      episodeId: onset.episodeId,
    });
    expect(pendingRestart.confirmOnset(onset.episodeId, 10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 1))
      .toEqual({ status: 'available', settled: true });

    const restarted = createSilenceRegistryEpisodeStore(statePath);
    expect(restarted.prepareOnset({ reasonClass: 'invalid_json', readBasis: 'none' }, 10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 2))
      .toEqual({ status: 'available', action: 'suppressed' });
    const recovery = restarted.prepareRecovery(10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 3);
    expect(recovery).toMatchObject({
      status: 'available',
      action: 'emit_recovery',
      episodeId: onset.episodeId,
    });
    expect(restarted.confirmRecovery(onset.episodeId, 10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 4))
      .toEqual({ status: 'available', settled: true });

    const afterRecoveryRestart = createSilenceRegistryEpisodeStore(statePath);
    expect(afterRecoveryRestart.prepareRecovery(10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 5))
      .toEqual({ status: 'available', action: 'suppressed' });

    writeFileSync(statePath, `${JSON.stringify({
      v: 1,
      phase: 'open',
      episodeId: onset.episodeId,
      updatedAt: new Date(10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 6).toISOString(),
      reasonClass: 'invalid_json',
      readBasis: 'none',
      recoveryFrom: null,
    })}\n`, { mode: 0o600 });
    chmodSync(statePath, 0o600);
    const primaryRecoveredButStale = createSilenceRegistryEpisodeStore(statePath);
    expect(primaryRecoveredButStale.prepareRecovery(10_000 + SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS + 7))
      .toEqual({ status: 'available', action: 'suppressed' });
  });
});
