/**
 * S2 — effective-client receipt (bond-revocation programme, 2026-08-17).
 *
 * Two questions this pins, both unanswerable before it:
 *
 *  1. What client identity did WhatsApp actually see? Only the protocol tuple was
 *     logged, as a bare label — so two identical tuples across a revocation
 *     boundary were NOT evidence of identical client behaviour, and "the tuple did
 *     not change" refuted less than it looked like it did.
 *  2. Did a fetch failure masquerade as success? It did. The installed dependency
 *     answers EVERY failure class (DNS, non-OK HTTP incl. 429, parser drift,
 *     malformed response) from one catch returning
 *     `{version: bundledFallback, isLatest: false, error}`, and the resolver
 *     discarded both `isLatest` and `error` while labelling the result `latest`.
 *
 * The load-bearing tests here are the ones that check a MISSING observation is
 * never reported as an observed value: `unknown` rather than `live_fetch` when the
 * upstream shape is unexpected, and `unavailable` rather than a synthesised
 * receipt when nothing has been recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@whiskeysockets/baileys', () => ({
  fetchLatestBaileysVersion: vi.fn(),
}));

import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { resolveBaileysVersion, type ResolvedBaileysVersion } from '../../src/transport/baileys-version.ts';
import {
  buildEffectiveClientReceipt,
  effectiveClientRegistry,
  OBSERVED_LIBRARY_DEFAULTS,
  resolveEffectiveClientEvidence,
  type SocketConfigLike,
} from '../../src/transport/effective-client-receipt.ts';

const RESOLVED: ResolvedBaileysVersion = {
  version: [2, 3000, 1043857760],
  source: 'live_fetch',
  isLatest: true,
  fetchErrorClass: null,
};

beforeEach(() => {
  effectiveClientRegistry.reset();
  vi.mocked(fetchLatestBaileysVersion).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('S2 — honest protocol-version provenance', () => {
  it('reports live_fetch only when upstream says isLatest: true', async () => {
    vi.mocked(fetchLatestBaileysVersion).mockResolvedValue({
      version: [2, 3000, 1021],
      isLatest: true,
    } as never);
    await expect(resolveBaileysVersion()).resolves.toEqual({
      version: [2, 3000, 1021],
      source: 'live_fetch',
      isLatest: true,
      fetchErrorClass: null,
    });
  });

  it('reports bundled_fallback — never latest — when the fetch failed', async () => {
    // This is the shape the installed dependency returns for DNS failure, HTTP
    // 429, parser drift and malformed responses alike. Before S2 this was
    // reported as `source: 'latest'`.
    vi.mocked(fetchLatestBaileysVersion).mockResolvedValue({
      version: [2, 3000, 1015901307],
      isLatest: false,
      error: new TypeError('fetch failed'),
    } as never);
    const resolved = await resolveBaileysVersion();
    expect(resolved.source).toBe('bundled_fallback');
    expect(resolved.isLatest).toBe(false);
    expect(resolved.fetchErrorClass).toBe('TypeError');
    // The old label must be gone entirely, not merely deprioritised.
    expect(resolved.source).not.toBe('latest');
  });

  it('records only the error CLASS, never the message', async () => {
    // Upstream errors embed the raw GitHub URL and HTTP status text.
    vi.mocked(fetchLatestBaileysVersion).mockResolvedValue({
      version: [2, 3000, 1],
      isLatest: false,
      error: new Error('Failed to fetch https://raw.githubusercontent.com/secret/path: 429'),
    } as never);
    const resolved = await resolveBaileysVersion();
    expect(resolved.fetchErrorClass).toBe('Error');
    const serialised = JSON.stringify(resolved);
    expect(serialised).not.toContain('githubusercontent');
    expect(serialised).not.toContain('429');
  });

  it('reports unknown when the upstream shape carries no isLatest at all', async () => {
    // A missing success signal is NOT a success. This branch is exactly where the
    // old code said `latest`.
    vi.mocked(fetchLatestBaileysVersion).mockResolvedValue({ version: [2, 2413, 1] } as never);
    const resolved = await resolveBaileysVersion();
    expect(resolved.source).toBe('unknown');
    expect(resolved.isLatest).toBeNull();
  });

  it('does not touch the network for a pinned version', async () => {
    await expect(resolveBaileysVersion('2.3000.1021')).resolves.toEqual({
      version: [2, 3000, 1021],
      source: 'pinned',
      isLatest: null,
      fetchErrorClass: null,
    });
    expect(fetchLatestBaileysVersion).not.toHaveBeenCalled();
  });
});

describe('S2 — the receipt describes the socket that was actually built', () => {
  it('reads the tuple off the config, not off the resolver', () => {
    // If a call site ever passes something other than the resolved tuple, the
    // receipt must show what the SOCKET got. This is the whole reason the receipt
    // is derived from the config object rather than assembled in parallel.
    const config: SocketConfigLike = { version: [9, 9, 9] };
    const receipt = buildEffectiveClientReceipt(config, RESOLVED, 'connection');
    expect(receipt.protocolVersion).toBe('9.9.9');
    expect(receipt.protocolVersionTuple).toEqual([9, 9, 9]);
    // …while resolver provenance still travels with it.
    expect(receipt.protocolVersionSource).toBe('live_fetch');
  });

  it('marks inherited library defaults as library_default, not as a blank', () => {
    // The finding this exists for: neither socket path passes browser,
    // syncFullHistory or markOnlineOnConnect, so both silently run with
    // syncFullHistory=true and markOnlineOnConnect=true. That is a real behaviour
    // nobody chose and nobody could see.
    const receipt = buildEffectiveClientReceipt({ version: [2, 3000, 1] }, RESOLVED, 'connection');
    expect(receipt.syncFullHistory).toEqual({ value: true, provenance: 'library_default' });
    expect(receipt.markOnlineOnConnect).toEqual({ value: true, provenance: 'library_default' });
    expect(receipt.browser).toEqual({
      value: OBSERVED_LIBRARY_DEFAULTS.browser,
      provenance: 'library_default',
    });
  });

  it('marks explicitly passed values as explicit', () => {
    const receipt = buildEffectiveClientReceipt(
      {
        version: [2, 3000, 1],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: true,
        browser: ['Ubuntu', 'Firefox', '1.0'],
      },
      RESOLVED,
      'pairing_cli',
    );
    expect(receipt.syncFullHistory).toEqual({ value: false, provenance: 'explicit' });
    expect(receipt.generateHighQualityLinkPreview.provenance).toBe('explicit');
    expect(receipt.browser.value).toEqual(['Ubuntu', 'Firefox', '1.0']);
    expect(receipt.callSite).toBe('pairing_cli');
  });

  it('records presence of auth material without recording any of it', () => {
    const receipt = buildEffectiveClientReceipt(
      { version: [2, 3000, 1], auth: { creds: { noiseKey: 'SECRETKEYMATERIAL' }, keys: {} } },
      RESOLVED,
      'connection',
    );
    expect(receipt.authSupplied).toBe(true);
    expect(receipt.keyStoreCacheable).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain('SECRETKEYMATERIAL');
    expect(JSON.stringify(receipt)).not.toContain('noiseKey');
  });

  it('keeps the two call sites distinct, and prefers the runtime connection', () => {
    effectiveClientRegistry.record(
      buildEffectiveClientReceipt({ version: [1, 1, 1] }, RESOLVED, 'pairing_cli'),
    );
    let evidence = resolveEffectiveClientEvidence();
    expect(evidence.status).toBe('recorded');
    if (evidence.status !== 'recorded') return;
    expect(evidence.receipt.callSite).toBe('pairing_cli');

    effectiveClientRegistry.record(
      buildEffectiveClientReceipt({ version: [2, 2, 2] }, RESOLVED, 'connection'),
    );
    evidence = resolveEffectiveClientEvidence();
    if (evidence.status !== 'recorded') throw new Error('expected recorded');
    expect(evidence.receipt.callSite).toBe('connection');
    expect(evidence.receipt.protocolVersion).toBe('2.2.2');
  });

  it('reports unavailable/not_recorded before any socket is built', () => {
    const evidence = resolveEffectiveClientEvidence();
    expect(evidence).toEqual({ status: 'unavailable', version: 1, reason: 'not_recorded' });
  });

  it('degrades to unavailable rather than throwing', () => {
    // Same fault isolation as the S1 actor receipt: persistBondEvent wraps its
    // entire payload in one try/catch whose only handler is a log.warn, so a
    // throwing receptor would discard the terminal bond event itself.
    const exploding = {
      current: () => {
        throw new Error('registry exploded');
      },
    } as unknown as typeof effectiveClientRegistry;
    expect(resolveEffectiveClientEvidence(exploding)).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'resolver_threw',
    });
  });
});

describe('S2 — the recorded library defaults must track the installed dependency', () => {
  it('matches @whiskeysockets/baileys DEFAULT_CONNECTION_CONFIG', async () => {
    // A dependency bump that moves these defaults would silently make every
    // receipt's `library_default` values wrong. Fail here instead.
    const defaults = await import('@whiskeysockets/baileys/lib/Defaults/index.js').catch(
      () => null,
    );
    if (!defaults) {
      // Never silently pass: if the path moves, that is itself the signal.
      throw new Error(
        'could not load baileys Defaults to verify OBSERVED_LIBRARY_DEFAULTS — update this test',
      );
    }
    const cfg = (defaults as { DEFAULT_CONNECTION_CONFIG?: Record<string, unknown> })
      .DEFAULT_CONNECTION_CONFIG;
    expect(cfg, 'DEFAULT_CONNECTION_CONFIG must exist').toBeDefined();
    expect(cfg!['syncFullHistory']).toBe(OBSERVED_LIBRARY_DEFAULTS.syncFullHistory);
    expect(cfg!['markOnlineOnConnect']).toBe(OBSERVED_LIBRARY_DEFAULTS.markOnlineOnConnect);
    expect(cfg!['browser']).toEqual(OBSERVED_LIBRARY_DEFAULTS.browser);
  });
});
