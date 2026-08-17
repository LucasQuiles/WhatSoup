import { afterEach, describe, expect, it, vi } from 'vitest';

// S2 (2026-08-17): the mock now carries `isLatest`, because the resolver no longer
// discards it. A result WITHOUT `isLatest` resolves to `source: 'unknown'` — an
// absent success signal is not a success — which the dedicated fallback/unknown
// cases in tests/transport/effective-client-receipt.test.ts cover in full.
vi.mock('@whiskeysockets/baileys', () => ({
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1], isLatest: true }),
}));

import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import {
  baileysVersionLabel,
  parsePinnedBaileysVersion,
  resolveBaileysVersion,
} from '../../src/transport/baileys-version.ts';

afterEach(() => {
  vi.clearAllMocks();
});

describe('baileys-version', () => {
  it('uses the fetched Baileys version by default', async () => {
    await expect(resolveBaileysVersion()).resolves.toEqual({
      version: [2, 2413, 1],
      source: 'live_fetch',
      isLatest: true,
      fetchErrorClass: null,
    });
    expect(fetchLatestBaileysVersion).toHaveBeenCalledTimes(1);
  });

  it('uses a pinned Baileys version without calling the network resolver', async () => {
    await expect(resolveBaileysVersion('2.3000.1021')).resolves.toEqual({
      version: [2, 3000, 1021],
      source: 'pinned',
      isLatest: null,
      fetchErrorClass: null,
    });
    expect(fetchLatestBaileysVersion).not.toHaveBeenCalled();
  });

  it('ignores ambient env — only the passed pin value matters (#2192 s4a)', async () => {
    process.env['WHATSOUP_BAILEYS_VERSION'] = '9.9999.9999';
    try {
      await expect(resolveBaileysVersion()).resolves.toEqual({
        version: [2, 2413, 1],
        source: 'live_fetch',
        isLatest: true,
        fetchErrorClass: null,
      });
    } finally {
      delete process.env['WHATSOUP_BAILEYS_VERSION'];
    }
    expect(fetchLatestBaileysVersion).toHaveBeenCalledTimes(1);
  });

  it('formats version tuples for diagnostics', () => {
    expect(baileysVersionLabel([2, 3000, 1021])).toBe('2.3000.1021');
  });

  it('rejects malformed pinned versions', () => {
    expect(() => parsePinnedBaileysVersion('2.3000')).toThrow(/dotted version tuple/);
    expect(() => parsePinnedBaileysVersion('2.latest.1021')).toThrow(/numeric tuple parts/);
    expect(() => parsePinnedBaileysVersion('-1.3000.1021')).toThrow(/numeric tuple parts/);
    expect(() => parsePinnedBaileysVersion('2.9007199254740992.1021')).toThrow(/safe non-negative integers/);
  });
});
