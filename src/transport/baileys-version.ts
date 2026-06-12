import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

export type BaileysVersionTuple = [number, number, number];
export type BaileysVersionSource = 'latest' | 'pinned';

export interface ResolvedBaileysVersion {
  version: BaileysVersionTuple;
  source: BaileysVersionSource;
}

export function baileysVersionLabel(version: readonly number[]): string {
  return version.join('.');
}

export function parsePinnedBaileysVersion(raw: string | undefined = process.env['WHATSOUP_BAILEYS_VERSION']): BaileysVersionTuple | null {
  const value = raw?.trim();
  if (!value) return null;

  const parts = value.split('.');
  if (parts.length !== 3) {
    throw new Error('WHATSOUP_BAILEYS_VERSION must be a dotted version tuple like 2.3000.1021');
  }

  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error('WHATSOUP_BAILEYS_VERSION must contain only numeric tuple parts');
    }
    return Number(part);
  });

  if (parsed.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error('WHATSOUP_BAILEYS_VERSION parts must be safe non-negative integers');
  }

  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

export async function resolveBaileysVersion(): Promise<ResolvedBaileysVersion> {
  const pinned = parsePinnedBaileysVersion();
  if (pinned) {
    return { version: pinned, source: 'pinned' };
  }

  const { version } = await fetchLatestBaileysVersion();
  return {
    version: [version[0]!, version[1]!, version[2]!],
    source: 'latest',
  };
}
