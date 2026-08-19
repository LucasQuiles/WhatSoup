import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeCredentialTreeDigest,
  persistAuthGenerationReceiptV2,
  resolveAuthGenerationEvidenceV2,
  readRestoreCandidateEvidence,
  observeActiveTree,
} from '../../src/transport/auth-generation-v2.ts';
import { writeAuthGenerationReceipt } from '../../src/transport/auth-generation.ts';

const CREATED_MS = Date.parse('2026-08-18T15:00:00.000Z');
const PERSISTED_MS = Date.parse('2026-08-18T15:00:01.000Z');

let root: string;
let authDir: string;
let stateRoot: string;

function writeCredFixture(): void {
  mkdirSync(join(authDir, 'keys'), { recursive: true });
  writeFileSync(join(authDir, 'creds.json'), '{"me":{"id":"fixture"}}');
  writeFileSync(join(authDir, 'keys', 'pre-key-1.json'), '{"k":1}');
}

function persistArgs(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: 'scope:line-a-wa',
    operationId: 'op-pairing-0001',
    authDir,
    stateRoot,
    createdAtMs: CREATED_MS,
    persistedAtMs: PERSISTED_MS,
    effectiveClient: { packageVersion: '7.0.0-rc12' },
    actorOperationId: null,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'auth-gen-v2-test-'));
  authDir = join(root, 'auth');
  stateRoot = join(root, 'state');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeCredFixture();
});

afterEach(() => {
  chmodSync(authDir, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('computeCredentialTreeDigest', () => {
  it('is deterministic over an identical tree', () => {
    const a = computeCredentialTreeDigest(authDir);
    const b = computeCredentialTreeDigest(authDir);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it('changes when one byte of one file changes', () => {
    const before = computeCredentialTreeDigest(authDir);
    writeFileSync(join(authDir, 'creds.json'), '{"me":{"id":"fixturX"}}');
    const after = computeCredentialTreeDigest(authDir);
    if (!before.ok || !after.ok) throw new Error('digest fixture unexpectedly failed');
    expect(after.digest).not.toBe(before.digest);
  });

  it('changes when a file is renamed (path is part of identity)', () => {
    const before = computeCredentialTreeDigest(authDir);
    rmSync(join(authDir, 'keys', 'pre-key-1.json'));
    writeFileSync(join(authDir, 'keys', 'pre-key-2.json'), '{"k":1}');
    const after = computeCredentialTreeDigest(authDir);
    if (!before.ok || !after.ok) throw new Error('digest fixture unexpectedly failed');
    expect(after.digest).not.toBe(before.digest);
  });

  it('fails closed on an empty tree', () => {
    const empty = join(root, 'empty-auth');
    mkdirSync(empty);
    expect(computeCredentialTreeDigest(empty)).toEqual({ ok: false, failure: 'empty' });
  });

  it('fails closed on an unreadable tree', () => {
    chmodSync(authDir, 0o000);
    expect(computeCredentialTreeDigest(authDir)).toEqual({ ok: false, failure: 'unreadable' });
  });
});

describe('persistAuthGenerationReceiptV2', () => {
  it('persists and the receipt binds scope, operation, and tree digest', () => {
    const result = persistAuthGenerationReceiptV2(persistArgs());
    if (!result.ok) throw new Error(`unexpected failure: ${result.failure}`);
    const digest = computeCredentialTreeDigest(authDir);
    if (!digest.ok) throw new Error('digest fixture unexpectedly failed');
    expect(result.receipt.scopeId).toBe('scope:line-a-wa');
    expect(result.receipt.operationId).toBe('op-pairing-0001');
    expect(result.receipt.credentialTreeDigest).toBe(digest.digest);
    expect(result.receipt.createdAt).toBe('2026-08-18T15:00:00.000Z');
    expect(result.receipt.persistedAt).toBe('2026-08-18T15:00:01.000Z');
  });

  it('round-trips through the resolver as recorded_v2', () => {
    const result = persistAuthGenerationReceiptV2(persistArgs());
    if (!result.ok) throw new Error(`unexpected failure: ${result.failure}`);
    const evidence = resolveAuthGenerationEvidenceV2(stateRoot);
    expect(evidence).toEqual({ status: 'recorded_v2', receipt: result.receipt });
  });

  it('fails closed on an invalid scope id', () => {
    expect(persistAuthGenerationReceiptV2(persistArgs({ scopeId: 'scope:+15550001234' }))).toEqual({
      ok: false,
      failure: 'scope_invalid',
    });
    expect(resolveAuthGenerationEvidenceV2(stateRoot).status).toBe('unavailable');
  });

  it('fails closed when the state root is missing', () => {
    expect(persistAuthGenerationReceiptV2(persistArgs({ stateRoot: null }))).toEqual({
      ok: false,
      failure: 'state_root_missing',
    });
  });

  it('fails closed when the credential tree digest is unavailable', () => {
    chmodSync(authDir, 0o000);
    expect(persistAuthGenerationReceiptV2(persistArgs())).toEqual({
      ok: false,
      failure: 'digest_unavailable',
    });
  });

  it('fails closed when persistedAt precedes createdAt', () => {
    expect(
      persistAuthGenerationReceiptV2(persistArgs({ persistedAtMs: CREATED_MS - 1000 })),
    ).toEqual({ ok: false, failure: 'clock_invalid' });
  });

  it('reports write_failed when the journal cannot be written, never a silent success', () => {
    const blocked = join(root, 'blocked-state');
    writeFileSync(blocked, 'not a directory');
    expect(persistAuthGenerationReceiptV2(persistArgs({ stateRoot: blocked }))).toEqual({
      ok: false,
      failure: 'write_failed',
    });
  });

  it('re-pairs of the same scope mint distinct generation ids', () => {
    const first = persistAuthGenerationReceiptV2(persistArgs());
    writeFileSync(join(authDir, 'creds.json'), '{"me":{"id":"fixture-2"}}');
    const second = persistAuthGenerationReceiptV2(
      persistArgs({ createdAtMs: CREATED_MS + 60_000, persistedAtMs: PERSISTED_MS + 60_000 }),
    );
    if (!first.ok || !second.ok) throw new Error('persist fixture unexpectedly failed');
    expect(second.receipt.generationId).not.toBe(first.receipt.generationId);
  });
});

describe('resolveAuthGenerationEvidenceV2', () => {
  it('reports no_receipt_written when nothing exists', () => {
    expect(resolveAuthGenerationEvidenceV2(stateRoot)).toEqual({
      status: 'unavailable',
      reason: 'no_receipt_written',
      bondCreatedAt: null,
    });
  });

  it('reports a legacy v1 receipt as legacy_v1, never as a v2 binding', () => {
    const legacy = writeAuthGenerationReceipt({
      accountJid: '15550001234@s.whatsapp.net',
      createdAtMs: CREATED_MS,
      stateRoot,
      authDir,
      pairingClient: null,
    });
    expect(legacy).not.toBeNull();
    const evidence = resolveAuthGenerationEvidenceV2(stateRoot);
    expect(evidence.status).toBe('legacy_v1');
  });

  it('prefers the v2 receipt when both exist', () => {
    writeAuthGenerationReceipt({
      accountJid: '15550001234@s.whatsapp.net',
      createdAtMs: CREATED_MS,
      stateRoot,
      authDir,
      pairingClient: null,
    });
    const result = persistAuthGenerationReceiptV2(persistArgs());
    if (!result.ok) throw new Error(`unexpected failure: ${result.failure}`);
    expect(resolveAuthGenerationEvidenceV2(stateRoot)).toEqual({
      status: 'recorded_v2',
      receipt: result.receipt,
    });
  });

  it('reports a malformed v2 journal as malformed, and does not fall back to allow', () => {
    const result = persistAuthGenerationReceiptV2(persistArgs());
    if (!result.ok) throw new Error(`unexpected failure: ${result.failure}`);
    writeFileSync(join(stateRoot, 'auth-generation.v2.json'), '{"v":1,"kind":"auth-generation-v2","receipt":{"v":2}}');
    expect(resolveAuthGenerationEvidenceV2(stateRoot)).toEqual({
      status: 'unavailable',
      reason: 'malformed',
      bondCreatedAt: null,
    });
  });

  it('reports null state root as no_receipt_written', () => {
    expect(resolveAuthGenerationEvidenceV2(null)).toEqual({
      status: 'unavailable',
      reason: 'no_receipt_written',
      bondCreatedAt: null,
    });
  });
});

describe('computeCredentialTreeDigest — bounds and nesting', () => {
  it('walks nested subdirectories (path is part of identity)', () => {
    mkdirSync(join(authDir, 'keys', 'app-state', 'nested'), { recursive: true });
    writeFileSync(join(authDir, 'keys', 'app-state', 'nested', 'k.json'), '{"deep":1}');
    const result = computeCredentialTreeDigest(authDir);
    if (!result.ok) throw new Error(`unexpected failure: ${result.failure}`);
    expect(result.fileCount).toBeGreaterThanOrEqual(3);
  });
});

describe('readRestoreCandidateEvidence', () => {
  it('reports missing manifest/receipt and no tree as missing/null', () => {
    const backupPath = join(root, 'backup-empty');
    mkdirSync(backupPath, { recursive: true });
    const evidence = readRestoreCandidateEvidence(backupPath);
    expect(evidence).toEqual({
      manifest: 'missing',
      generationReceipt: 'missing',
      observedTreeDigest: null,
    });
  });

  it('reports corrupt manifest/receipt json as corrupt', () => {
    const backupPath = join(root, 'backup-corrupt');
    mkdirSync(backupPath, { recursive: true });
    writeFileSync(join(backupPath, 'candidate-manifest.v2.json'), '{bad');
    writeFileSync(join(backupPath, 'generation-receipt.v2.json'), 'nope');
    const evidence = readRestoreCandidateEvidence(backupPath);
    expect(evidence.manifest).toBe('corrupt');
    expect(evidence.generationReceipt).toBe('corrupt');
  });

  it('reports a well-formed manifest/receipt and the backup tree digest', () => {
    const backupPath = join(root, 'backup-good');
    mkdirSync(join(backupPath, 'auth'), { recursive: true });
    writeFileSync(join(backupPath, 'auth', 'creds.json'), '{"me":{"id":"backup"}}');
    const treeDigest = computeCredentialTreeDigest(join(backupPath, 'auth'));
    if (!treeDigest.ok) throw new Error('backup tree digest failed');
    const manifest = {
      v: 2,
      snapshotId: 'snap-b1',
      sourceGenerationId: 'gen-b1',
      credentialTreeDigest: treeDigest.digest,
      snapshotAt: '2026-08-18T10:00:00.000Z',
      inventoryDigest: '2'.repeat(64),
    };
    const receipt = {
      v: 2,
      scopeId: 'scope:line-a-wa',
      generationId: 'gen-b1',
      operationId: 'op-b1',
      credentialTreeDigest: treeDigest.digest,
      createdAt: '2026-08-18T10:00:00.000Z',
      persistedAt: '2026-08-18T10:00:01.000Z',
      effectiveClient: null,
      actorOperationId: null,
      advisoryAuthRootHash: null,
    };
    writeFileSync(join(backupPath, 'candidate-manifest.v2.json'), JSON.stringify(manifest));
    writeFileSync(join(backupPath, 'generation-receipt.v2.json'), JSON.stringify(receipt));
    const evidence = readRestoreCandidateEvidence(backupPath);
    expect(evidence.manifest).toEqual(manifest);
    expect(evidence.observedTreeDigest).toBe(treeDigest.digest);
  });
});

describe('observeActiveTree', () => {
  it('reports missing for an absent dir and an empty dir, digest for a populated one', () => {
    expect(observeActiveTree(join(root, 'nope'))).toEqual({ status: 'missing' });
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(observeActiveTree(empty)).toEqual({ status: 'missing' });
    const obs = observeActiveTree(authDir);
    expect(obs.status).toBe('digest');
  });

  it('reports unreadable when the tree cannot be read', () => {
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'creds.json'), '{"x":1}');
    chmodSync(locked, 0o000);
    const obs = observeActiveTree(locked);
    chmodSync(locked, 0o700);
    expect(obs.status).toBe('unreadable');
  });
});

describe('resolveAuthGenerationEvidenceV2 — unreadable and threw branches', () => {
  it('reports unavailable/unreadable when the journal cannot be read', () => {
    const result = persistAuthGenerationReceiptV2(persistArgs());
    if (!result.ok) throw new Error(`unexpected failure: ${result.failure}`);
    const journalPath = join(stateRoot, 'auth-generation.v2.json');
    chmodSync(journalPath, 0o000);
    const evidence = resolveAuthGenerationEvidenceV2(stateRoot);
    chmodSync(journalPath, 0o600);
    expect(evidence.status).toBe('unavailable');
    if (evidence.status !== 'unavailable') throw new Error('unreachable');
    expect(['unreadable', 'resolver_threw']).toContain(evidence.reason);
  });
});
