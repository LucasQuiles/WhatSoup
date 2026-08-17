/**
 * S1 — actor receipt on bond events (bond-revocation programme, 2026-08-17).
 *
 * Every bond event previously hard-coded `ownerEvidence: { status: 'not_recorded' }`
 * — one literal, written 50,036 times, with no consumer and no type. When a
 * companion bond was revoked the system could say what happened and never who or
 * what asked for it.
 *
 * The contract these tests pin has three states, and the third is the point:
 *
 *   consulted   — the attribution channel was read. `bondRemovalRequest: null` is
 *                 then REAL NEGATIVE EVIDENCE ("no local path asked for removal"),
 *                 which is exactly what excluded `logout` for `q`.
 *   unavailable — the channel could not be read. This must NEVER be reported as
 *                 `unattributed`; that would convert "we did not look" into
 *                 "nothing was there", the proxy-promotion defect P7.3 names.
 *
 * The highest-value test here is the last one: a throwing resolver must not be
 * able to destroy the bond event. `persistBondEvent` wraps its whole payload
 * construction in ONE try/catch that only logs a warning, so a receipt that
 * throws mid-payload would silently delete the one record this programme exists
 * to capture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'wa-bond-actor-receipt-'));

const { mockConfig, logger } = vi.hoisted(() => {
  const log = {
    level: 'error',
    child: vi.fn(() => log),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    mockConfig: {
      adminPhones: new Set<string>(),
      authDir: '/tmp/wa-bond-actor-receipt-auth',
      stateRoot: '/tmp/wa-bond-actor-receipt-state',
      dataRoot: '',
      lockPath: '/tmp/wa-bond-actor-receipt.lock',
      dbPath: ':memory:',
      mediaDir: '/tmp/wa-bond-actor-receipt-media',
      botName: 'WhatSoup',
      accessMode: 'allowlist',
      healthPort: 9090,
      autoTyping: 'off' as 'off' | 'composing' | 'recording',
      generateHighQualityLinkPreview: false,
      maxExhaustionCycles: 99,
      models: {
        conversation: 'claude-opus-4-5',
        extraction: 'claude-haiku-4-5',
        validation: 'claude-haiku-4-5',
        fallback: 'claude-sonnet-4-5',
      },
    },
    logger: log,
  };
});

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  Object.assign(logger, singletonLoggerMock(), { fatal: vi.fn() });
  return { createChildLogger: () => logger };
});

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { shortHash } from '../../src/lib/short-hash.ts';
import {
  buildEffectiveClientReceipt,
  effectiveClientRegistry,
} from '../../src/transport/effective-client-receipt.ts';
import {
  bondActorLedger,
  createBondActorLedger,
  resolveBondOwnerEvidence,
  type BondOwnerEvidence,
} from '../../src/transport/bond-actor-receipt.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';

const ACTOR_JID = '15550000001@s.whatsapp.net';

/** Read every bond event the manager appended, newest last. */
function readBondEvents(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(DATA_ROOT, 'bond-events.ndjson'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Drive one real bond event through the real writer and return its receipt. */
function emitBondEventAndReadReceipt(): BondOwnerEvidence {
  mockConfig.dataRoot = DATA_ROOT;
  const manager = new ConnectionManager();
  // recordCredentialLifecycle is the sole caller of persistBondEvent; go through
  // it rather than the private writer so the test exercises the production join.
  (manager as unknown as {
    recordCredentialLifecycle: (event: string, detail?: unknown) => void;
  }).recordCredentialLifecycle('device_bond_lost');
  const events = readBondEvents();
  expect(events.length, 'the bond event must have been written').toBeGreaterThan(0);
  return events[events.length - 1].ownerEvidence as BondOwnerEvidence;
}

beforeEach(() => {
  vi.restoreAllMocks();
  bondActorLedger.reset();
});

describe('S1 — the bond actor ledger', () => {
  it('reports unattributed when consulted and empty, never a synthesised actor', () => {
    const evidence = resolveBondOwnerEvidence(createBondActorLedger());
    expect(evidence.status).toBe('consulted');
    if (evidence.status !== 'consulted') return;
    // The negative that excluded `logout` for `q`: the channel was read and no
    // local path had requested device removal.
    expect(evidence.bondRemovalRequest).toBeNull();
    expect(evidence.lastControlPlaneAction).toBeNull();
    expect(evidence.actorClass).toBe('unattributed');
  });

  it('records a device-removal request with route, derived class, and age', () => {
    const ledger = createBondActorLedger();
    ledger.recordBondRemovalRequest({
      route: 'mcp',
      action: 'mcp_tool:logout',
      actorIdentity: ACTOR_JID,
      requestId: 'durability:4242',
    });
    const evidence = resolveBondOwnerEvidence(ledger);
    expect(evidence.status).toBe('consulted');
    if (evidence.status !== 'consulted') return;
    expect(evidence.bondRemovalRequest).not.toBeNull();
    expect(evidence.bondRemovalRequest!.route).toBe('mcp');
    expect(evidence.bondRemovalRequest!.action).toBe('mcp_tool:logout');
    expect(evidence.bondRemovalRequest!.ageMs).toBeGreaterThanOrEqual(0);
    // route + actor identity => operator, and the raw route survives alongside
    // the derived class so the mapping stays auditable.
    expect(evidence.actorClass).toBe('operator');
  });

  it('derives api, not operator, when a route has no actor identity', () => {
    const ledger = createBondActorLedger();
    ledger.recordBondRemovalRequest({
      route: 'fleet_api',
      action: 'fleet:auth_delete',
      actorIdentity: null,
      requestId: null,
    });
    const evidence = resolveBondOwnerEvidence(ledger);
    if (evidence.status !== 'consulted') throw new Error('expected consulted');
    expect(evidence.actorClass).toBe('api');
    expect(evidence.bondRemovalRequest!.actorIdentityHash).toBeNull();
  });

  it('keeps generic control-plane traffic out of the removal-request field', () => {
    // A read-only tool call must not become an attribution. Temporal proximity
    // is not causation, and this field is the discriminator.
    const ledger = createBondActorLedger();
    ledger.recordControlPlaneAction({
      route: 'mcp',
      action: 'mcp_tool:list_chats',
      effect: 'read_only',
      actorIdentity: ACTOR_JID,
      requestId: 'durability:7',
    });
    const evidence = resolveBondOwnerEvidence(ledger);
    if (evidence.status !== 'consulted') throw new Error('expected consulted');
    expect(evidence.bondRemovalRequest).toBeNull();
    expect(evidence.actorClass).toBe('unattributed');
    expect(evidence.lastControlPlaneAction).not.toBeNull();
    expect(evidence.lastControlPlaneAction!.action).toBe('mcp_tool:list_chats');
    expect(evidence.lastControlPlaneAction!.effect).toBe('read_only');
    // The record must say out loud that it is not a causal claim.
    expect(evidence.causalRelation).toBe('temporal_only');
  });

  it('pseudonymises actor identity — no raw JID reaches the receipt', () => {
    const ledger = createBondActorLedger();
    ledger.recordBondRemovalRequest({
      route: 'mcp',
      action: 'mcp_tool:logout',
      actorIdentity: ACTOR_JID,
      requestId: null,
    });
    const evidence = resolveBondOwnerEvidence(ledger);
    if (evidence.status !== 'consulted') throw new Error('expected consulted');
    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain(ACTOR_JID);
    expect(serialised).not.toContain('15550000001');
    // Behaviour, not existence: the field must be exactly the shared short-hash
    // of the identity, so a future change to plain-text or a different digest
    // source turns this red.
    expect(evidence.bondRemovalRequest!.actorIdentityHash).toBe(shortHash(ACTOR_JID, 20));
  });

  it('reports unavailable — NOT unattributed — when the channel cannot be read', () => {
    const ledger = createBondActorLedger();
    vi.spyOn(ledger, 'resolve').mockImplementation(() => {
      throw new Error('ledger exploded');
    });
    const evidence = resolveBondOwnerEvidence(ledger);
    expect(evidence.status).toBe('unavailable');
    // The whole point of the three-state contract: an unread channel must never
    // be reported as an empty one.
    expect(JSON.stringify(evidence)).not.toContain('unattributed');
  });

  it('bounds itself — repeated actions do not accumulate', () => {
    const ledger = createBondActorLedger();
    for (let i = 0; i < 500; i += 1) {
      ledger.recordControlPlaneAction({
        route: 'mcp',
        action: `mcp_tool:probe_${i}`,
        effect: 'read_only',
        actorIdentity: null,
        requestId: null,
      });
    }
    const evidence = resolveBondOwnerEvidence(ledger);
    if (evidence.status !== 'consulted') throw new Error('expected consulted');
    // One slot, last write wins — no array, so no growth on a hot path.
    expect(evidence.lastControlPlaneAction!.action).toBe('mcp_tool:probe_499');
    expect(JSON.stringify(evidence).length).toBeLessThan(2_000);
  });
});

describe('S1 — the receipt is joined onto the persisted bond event', () => {
  it('replaces the hard-coded not_recorded literal', () => {
    const receipt = emitBondEventAndReadReceipt();
    // The literal this work exists to remove.
    expect((receipt as unknown as { status: string }).status).not.toBe('not_recorded');
    expect(receipt.status).toBe('consulted');
    if (receipt.status !== 'consulted') return;
    expect(receipt.bondRemovalRequest).toBeNull();
    expect(receipt.actorClass).toBe('unattributed');
  });

  it('carries a recorded removal request through to the durable event', () => {
    bondActorLedger.recordBondRemovalRequest({
      route: 'mcp',
      action: 'mcp_tool:logout',
      actorIdentity: ACTOR_JID,
      requestId: 'durability:99',
    });
    const receipt = emitBondEventAndReadReceipt();
    expect(receipt.status).toBe('consulted');
    if (receipt.status !== 'consulted') return;
    expect(receipt.bondRemovalRequest).not.toBeNull();
    expect(receipt.bondRemovalRequest!.action).toBe('mcp_tool:logout');
    expect(receipt.actorClass).toBe('operator');
  });

  it('carries the S2 effective-client receipt, describing the socket that was built', () => {
    // The join for S2. Before it, a bond event recorded the protocol tuple as a
    // bare label and nothing else about the client — so identical tuples across a
    // revocation boundary were not evidence of identical client behaviour.
    effectiveClientRegistry.reset();
    effectiveClientRegistry.record(
      buildEffectiveClientReceipt(
        { version: [2, 3000, 1043857760], generateHighQualityLinkPreview: false },
        {
          version: [2, 3000, 1043857760],
          source: 'bundled_fallback',
          isLatest: false,
          fetchErrorClass: 'TypeError',
        },
        'connection',
      ),
    );
    mockConfig.dataRoot = DATA_ROOT;
    const manager = new ConnectionManager();
    (manager as unknown as {
      recordCredentialLifecycle: (event: string, detail?: unknown) => void;
    }).recordCredentialLifecycle('device_bond_lost');
    const events = readBondEvents();
    const client = events[events.length - 1].effectiveClient as {
      status: string;
      receipt?: Record<string, unknown>;
    };
    expect(client.status).toBe('recorded');
    expect(client.receipt!['protocolVersion']).toBe('2.3000.1043857760');
    // The honest provenance must survive the join — a failed fetch must not read
    // as `latest` on the durable record.
    expect(client.receipt!['protocolVersionSource']).toBe('bundled_fallback');
    expect(client.receipt!['protocolVersionIsLatest']).toBe(false);
    // And the silently inherited library defaults must be visible as such.
    expect(client.receipt!['syncFullHistory']).toEqual({
      value: true,
      provenance: 'library_default',
    });
  });

  it('records effectiveClient as unavailable — not synthesised — with no socket built', () => {
    effectiveClientRegistry.reset();
    mockConfig.dataRoot = DATA_ROOT;
    const manager = new ConnectionManager();
    (manager as unknown as {
      recordCredentialLifecycle: (event: string, detail?: unknown) => void;
    }).recordCredentialLifecycle('device_bond_lost');
    const events = readBondEvents();
    expect(events[events.length - 1].effectiveClient).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'not_recorded',
    });
  });

  it('carries the S3 auth-generation receipt, null-with-reason for a pre-S3 bond', () => {
    // Every bond in the fleet today lands on `no_receipt_written`, because the
    // receipt is created at pairing. That is the honest answer — backfilling it
    // from the auth directory's mtime or process uptime is named as a failure
    // criterion in the plan, and the unowned quarantine artifacts make it tempting.
    mockConfig.dataRoot = DATA_ROOT;
    const manager = new ConnectionManager();
    (manager as unknown as {
      recordCredentialLifecycle: (event: string, detail?: unknown) => void;
    }).recordCredentialLifecycle('device_bond_lost');
    const events = readBondEvents();
    const gen = events[events.length - 1].authGeneration as Record<string, unknown>;
    expect(gen['status']).toBe('unavailable');
    expect(gen['reason']).toBe('no_receipt_written');
    // The field must be present and explicitly null, not absent — an absent field
    // reads as "not implemented" and invites a derived value later.
    expect(gen).toHaveProperty('bondCreatedAt', null);
  });

  it('still writes the bond event when the receipt resolver throws', () => {
    // THE fault-isolation test. persistBondEvent builds its whole payload inside
    // one try/catch whose only handler is a log.warn, so an exception raised
    // while resolving the receipt would discard the entire terminal event — the
    // exact record that must survive. The receipt must degrade, not destroy.
    vi.spyOn(bondActorLedger, 'resolve').mockImplementation(() => {
      throw new Error('resolver exploded');
    });
    const before = (() => {
      try {
        return readBondEvents().length;
      } catch {
        return 0;
      }
    })();

    const receipt = emitBondEventAndReadReceipt();

    expect(readBondEvents().length, 'the bond event must survive a throwing receipt').toBe(
      before + 1,
    );
    expect(receipt.status).toBe('unavailable');
    expect(JSON.stringify(receipt)).not.toContain('unattributed');
  });
});
