import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@whiskeysockets/baileys', () => ({
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
}));

import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import {
  baileysVersionLabel,
  parsePinnedBaileysVersion,
  resolveBaileysVersion,
} from '../../src/transport/baileys-version.ts';

afterEach(() => {
  delete process.env['WHATSOUP_BAILEYS_VERSION'];
  vi.clearAllMocks();
});

describe('baileys-version', () => {
  it('uses the fetched Baileys version by default', async () => {
    await expect(resolveBaileysVersion()).resolves.toEqual({
      version: [2, 2413, 1],
      source: 'latest',
    });
    expect(fetchLatestBaileysVersion).toHaveBeenCalledTimes(1);
  });

  it('uses a pinned Baileys version without calling the network resolver', async () => {
    process.env['WHATSOUP_BAILEYS_VERSION'] = '2.3000.1021';

    await expect(resolveBaileysVersion()).resolves.toEqual({
      version: [2, 3000, 1021],
      source: 'pinned',
    });
    expect(fetchLatestBaileysVersion).not.toHaveBeenCalled();
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
