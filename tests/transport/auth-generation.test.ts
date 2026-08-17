/**
 * S3 — auth generation receipt (bond-revocation programme, 2026-08-17).
 *
 * `bond_created_at` was never recorded. Every bond age in the investigation was
 * DERIVED from quarantine-directory mtimes — and a repo-wide search found **no
 * producer of those directories anywhere in this codebase**, in at least seven
 * different naming conventions across hosts. They are an unowned side effect of
 * external tooling.
 *
 * The tests that matter here are the refusals. The plan names three derivations as
 * failure criteria — auth-directory birth, credential-file mtime, process uptime —
 * and the quarantine artifacts make the first two look easy. So the contract is:
 * where the generation was not observed at pairing, report `null` WITH A REASON, and
 * distinguish "never written" from "written but unreadable".
 *
 * Note the consequence these tests pin deliberately: every bond that exists today
 * reports `no_receipt_written`. That is correct, not a gap — backfilling it from
 * timestamps is the derivation this module refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/config.ts', () => ({
  config: { stateRoot: null, authDir: '/tmp/wa-s3-auth' },
}));

import {
  resolveAuthGenerationEvidence,
  writeAuthGenerationReceipt,
} from '../../src/transport/auth-generation.ts';
import { buildEffectiveClientReceipt } from '../../src/transport/effective-client-receipt.ts';

const ACCOUNT_JID = '15550000002@s.whatsapp.net';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'wa-s3-generation-'));
});

/**
 * Write a receipt fixture with 0600.
 *
 * The private-fs layer under this journal enforces a private DIRECTORY (0700) and a
 * private FILE (0600) *before* any content is parsed, so a fixture left at the
 * default 0644 reports `unreadable` and never reaches the field validation these
 * tests are aiming at. That ordering is correct security behaviour and is pinned
 * separately below.
 */
function writeReceiptFixture(body: string): string {
  const path = join(stateRoot, 'auth-generation.json');
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o600);
  return path;
}

const VALID_PAIRING_CLIENT = buildEffectiveClientReceipt(
  { version: [2, 3000, 1043857760] },
  {
    version: [2, 3000, 1043857760],
    source: 'live_fetch',
    isLatest: true,
    fetchErrorClass: null,
  },
  'pairing_cli',
);

function writeGenerationWithPairingClient(pairingClient: unknown): void {
  writeReceiptFixture(JSON.stringify({
    v: 1,
    generationId: 'generation-1',
    bondCreatedAt: '2026-08-17T04:36:39.000Z',
    source: 'pairing_cli',
    identityDigest: 'identity-digest',
    authRootHash: 'auth-root-hash',
    pairingClient,
  }));
}

describe('S3 — writing the generation receipt', () => {
  it('records the observed pairing instant and a generation id', () => {
    const createdAtMs = Date.UTC(2026, 7, 17, 4, 36, 39);
    const receipt = writeAuthGenerationReceipt({
      accountJid: ACCOUNT_JID,
      createdAtMs,
      stateRoot,
      authDir: '/tmp/wa-s3-auth',
    });
    expect(receipt).not.toBeNull();
    expect(receipt!.bondCreatedAt).toBe('2026-08-17T04:36:39.000Z');
    expect(receipt!.source).toBe('pairing_cli');
    expect(receipt!.generationId.length).toBeGreaterThan(0);

    const evidence = resolveAuthGenerationEvidence(stateRoot);
    expect(evidence.status).toBe('recorded');
    if (evidence.status !== 'recorded') return;
    expect(evidence.receipt.bondCreatedAt).toBe('2026-08-17T04:36:39.000Z');
    expect(evidence.receipt.generationId).toBe(receipt!.generationId);
  });

  it('gives a re-pair of the same account a DIFFERENT generation id', () => {
    // This is the property that lets a re-revocation be distinguished from a
    // re-emission — the exact ambiguity that made the census unable to say whether
    // any line had been revoked twice.
    const first = writeAuthGenerationReceipt({
      accountJid: ACCOUNT_JID,
      createdAtMs: Date.UTC(2026, 5, 29, 10, 17, 48),
      stateRoot,
    });
    const second = writeAuthGenerationReceipt({
      accountJid: ACCOUNT_JID,
      createdAtMs: Date.UTC(2026, 7, 17, 4, 36, 39),
      stateRoot,
    });
    expect(first!.generationId).not.toBe(second!.generationId);
    // Same account, so the identity digest is stable across generations.
    expect(first!.identityDigest).toBe(second!.identityDigest);
  });

  it('never stores a raw JID', () => {
    writeAuthGenerationReceipt({ accountJid: ACCOUNT_JID, createdAtMs: Date.now(), stateRoot });
    const raw = readFileSync(join(stateRoot, 'auth-generation.json'), 'utf8');
    expect(raw).not.toContain(ACCOUNT_JID);
    expect(raw).not.toContain('15550000002');
  });

  it('records identityDigest as null when the account id is unknown', () => {
    // auth.ts falls back to the literal 'unknown' when sock.user?.id is absent.
    // That must not be hashed into something that looks like an identity.
    const receipt = writeAuthGenerationReceipt({
      accountJid: 'unknown',
      createdAtMs: Date.UTC(2026, 7, 17, 4, 36, 39),
      stateRoot,
      authDir: '/tmp/wa-s3-auth',
    });
    expect(receipt).toEqual({
      version: 1,
      generationId: '830d02211ffbd42e6db239d1',
      bondCreatedAt: '2026-08-17T04:36:39.000Z',
      source: 'pairing_cli',
      identityDigest: null,
      authRootHash: 'd7abebfe1631ab1eb9be',
      pairingClient: null,
    });
  });

  it('returns null instead of throwing when there is nowhere to write', () => {
    expect(
      writeAuthGenerationReceipt({ accountJid: ACCOUNT_JID, createdAtMs: Date.now(), stateRoot: null }),
    ).toBeNull();
  });
});

describe('S3 — the refusals', () => {
  it('round-trips a strictly valid persisted pairing client', () => {
    writeGenerationWithPairingClient(VALID_PAIRING_CLIENT);

    const evidence = resolveAuthGenerationEvidence(stateRoot);

    expect(evidence.status).toBe('recorded');
    if (evidence.status !== 'recorded') return;
    expect(evidence.receipt.pairingClient).toEqual(VALID_PAIRING_CLIENT);
    expect(evidence.receipt.pairingClient).not.toBe(VALID_PAIRING_CLIENT);
  });

  it.each([
    ['contradictory tuple', { protocolVersionTuple: [9, 9, 9] }],
    ['contradictory source', { protocolVersionResolverMatch: false }],
    ['bad call site', { callSite: 'background_worker' }],
    ['bad receipt version', { version: 2 }],
  ])('reports malformed for a pairing client with %s', (_label, change) => {
    writeGenerationWithPairingClient({ ...VALID_PAIRING_CLIENT, ...change });

    const evidence = resolveAuthGenerationEvidence(stateRoot);

    expect(evidence).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'malformed',
      bondCreatedAt: null,
    });
  });

  it('reports malformed when a valid runtime connection receipt is stored as the pairing client', () => {
    writeGenerationWithPairingClient({ ...VALID_PAIRING_CLIENT, callSite: 'connection' });

    expect(resolveAuthGenerationEvidence(stateRoot)).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'malformed',
      bondCreatedAt: null,
    });
  });

  it('reports malformed for oversized pairing-client strings', () => {
    writeGenerationWithPairingClient({
      ...VALID_PAIRING_CLIENT,
      browser: {
        ...VALID_PAIRING_CLIENT.browser,
        value: ['x'.repeat(1025), 'Chrome', '1'],
        provenance: 'explicit',
      },
    });

    expect(resolveAuthGenerationEvidence(stateRoot)).toMatchObject({
      status: 'unavailable',
      reason: 'malformed',
    });
  });

  it('reports malformed for unknown nested pairing-client keys', () => {
    writeGenerationWithPairingClient({
      ...VALID_PAIRING_CLIENT,
      browser: { ...VALID_PAIRING_CLIENT.browser, credentials: { arbitrary: true } },
    });

    expect(resolveAuthGenerationEvidence(stateRoot)).toMatchObject({
      status: 'unavailable',
      reason: 'malformed',
    });
  });

  it('reports no_receipt_written with a null age for a pre-existing bond', () => {
    // Every bond in the fleet today lands here. The temptation is to fill this in
    // from the auth directory's mtime; the plan names that as a failure criterion.
    const evidence = resolveAuthGenerationEvidence(stateRoot);
    expect(evidence).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'no_receipt_written',
      bondCreatedAt: null,
    });
  });

  it('distinguishes unreadable from never-written', () => {
    // A receipt that exists but cannot be parsed is a DIFFERENT fact from one that
    // was never written. Collapsing them would turn "never recorded" into "lost".
    writeReceiptFixture('{ this is not json');
    const evidence = resolveAuthGenerationEvidence(stateRoot);
    expect(evidence).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'unreadable',
      bondCreatedAt: null,
    });
  });

  it('reports malformed for a valid envelope with an unusable timestamp', () => {
    writeReceiptFixture(
      JSON.stringify({ v: 1, generationId: 'g1', bondCreatedAt: 'not-a-date', source: 'pairing_cli', authRootHash: 'h' }),
    );
    const evidence = resolveAuthGenerationEvidence(stateRoot);
    expect(evidence).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'malformed',
      bondCreatedAt: null,
    });
  });

  it('rejects a receipt whose source is not a recognised establishment path', () => {
    // Guards against a hand-edited or foreign file asserting a generation the
    // application never established.
    writeReceiptFixture(
      JSON.stringify({
        v: 1,
        generationId: 'g1',
        bondCreatedAt: '2026-08-17T04:36:39.000Z',
        source: 'derived_from_directory_mtime',
        authRootHash: 'h',
      }),
    );
    const evidence = resolveAuthGenerationEvidence(stateRoot);
    if (evidence.status !== 'unavailable') throw new Error('expected unavailable');
    expect(evidence.reason).toBe('malformed');
  });

  it('never derives bondCreatedAt from the file it just read', () => {
    // The subtlest failure mode: a malformed receipt whose own mtime is "obviously"
    // the pairing time. The resolver must not fall back to it.
    writeReceiptFixture(
      JSON.stringify({ v: 1, generationId: 'g', source: 'pairing_cli', authRootHash: 'h' }),
    );
    const evidence = resolveAuthGenerationEvidence(stateRoot);
    if (evidence.status !== 'unavailable') throw new Error('expected unavailable');
    expect(evidence.bondCreatedAt).toBeNull();
    // And nothing in the record may carry a date at all.
    expect(JSON.stringify(evidence)).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it('treats a world-readable receipt as unreadable, not as data', () => {
    // The private-fs layer refuses a receipt at loose permissions before parsing
    // it. A generation identity is security-relevant state, so reading it from a
    // 0644 file would be the wrong trade — and the failure must be visible as
    // `unreadable` rather than silently becoming a usable value.
    const path = join(stateRoot, 'auth-generation.json');
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        generationId: 'g1',
        bondCreatedAt: '2026-08-17T04:36:39.000Z',
        source: 'pairing_cli',
        authRootHash: 'h',
      }),
      'utf8',
    );
    chmodSync(path, 0o644);
    const evidence = resolveAuthGenerationEvidence(stateRoot);
    expect(evidence).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'unreadable',
      bondCreatedAt: null,
    });
  });

  it('degrades to resolver_threw rather than propagating', () => {
    // Same fault isolation as S1/S2: persistBondEvent wraps its whole payload in
    // one try/catch whose only handler is a log.warn, so a throwing receptor would
    // discard the terminal bond event itself.
    const evidence = resolveAuthGenerationEvidence({} as unknown as string);
    expect(evidence).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'resolver_threw',
      bondCreatedAt: null,
    });
  });
});
