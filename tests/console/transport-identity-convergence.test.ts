/**
 * transport-identity convergence (T5 b-13 gate).
 *
 * b-03 shipped a fleet-local transport→glyph map and b-07 shipped the
 * console-wide transport-identity home; both PRs flagged that one had to
 * absorb the other once both landed. It landed as: the shared mapping and copy
 * live once in `lib/transport-identity.ts`, and `fleet/channel-kind.ts` extends
 * that vocabulary with the fleet-only silhouettes.
 *
 * These pins are the regression protection for that convergence — every raw
 * transport spelling the pre-convergence fleet map resolved must still resolve
 * identically, the copy must have exactly one spelling per channel, and the
 * glyph fallback must never surface 'unknown' (the column has to draw a shape).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { channelKindOf, CHANNEL_LABEL } from '../../console/src/components/fleet/channel-kind';
import { channelOf, CHANNEL_LABEL as BASE_LABEL, baileysFallbackChannel } from '../../console/src/lib/transport-identity';
import type { LineInstance } from '../../console/src/types';

const lineWith = (kind?: string, whatsapp?: unknown): LineInstance =>
  ({
    name: 'l',
    health: {
      ...(kind ? { transport: { kind } } : {}),
      ...(whatsapp ? { whatsapp } : {}),
    },
  } as unknown as LineInstance);

describe('fleet glyph map — every pre-convergence spelling still resolves', () => {
  // The exact table the b-03 fleet map carried before it converged.
  const cases: Array<[string, string]> = [
    ['baileys', 'wa'], ['whatsapp', 'wa'], ['wa', 'wa'], ['WA', 'wa'],
    ['signal', 'signal'],
    ['imessage', 'imessage'], ['imsg', 'imessage'], ['apple', 'imessage'],
    ['twilio', 'sms'], ['sms', 'sms'],
    ['discord', 'discord'], ['telegram', 'telegram'],
    ['x', 'x'], ['twitter', 'x'],
    ['linkedin', 'linkedin'], ['reddit', 'reddit'], ['instagram', 'instagram'],
    ['facebook', 'facebook'],
    ['email', 'email'], ['smtp', 'email'], ['mail', 'email'],
    ['slack', 'slack'], ['teams', 'teams'],
  ];
  for (const [raw, expected] of cases) {
    it(`${raw} → ${expected}`, () => {
      expect(channelKindOf(lineWith(raw))).toBe(expected);
    });
  }
});

describe('fleet glyph map — honest fallbacks', () => {
  it('an unrecognized transport kind degrades to the sms bars, never a wrong glyph', () => {
    expect(channelKindOf(lineWith('carrier-pigeon'))).toBe('sms');
  });

  it('a Baileys-era line with no transport block resolves via the legacy key', () => {
    // Presence of the legacy block is the signal, not its connected state — a
    // disconnected Baileys line is still a WhatsApp line.
    expect(channelKindOf(lineWith(undefined, { connected: true }))).toBe('wa');
    expect(baileysFallbackChannel(lineWith(undefined, { connected: false }))).toBe('wa');
    expect(channelKindOf(lineWith(undefined))).toBe('sms');
    expect(baileysFallbackChannel(undefined)).toBe('sms');
  });

  it("never returns 'unknown' — the glyph column must draw a shape", () => {
    for (const raw of [undefined, '', 'nonsense', 'baileys']) {
      expect(channelKindOf(lineWith(raw))).not.toBe('unknown');
    }
  });

  it("the console-wide map stays honest where the fleet map degrades", () => {
    // The distinction that justifies two vocabularies: generic surfaces say
    // "unknown"; only the glyph column substitutes a shape.
    expect(channelOf(lineWith('carrier-pigeon'))).toBe('unknown');
    expect(channelOf(lineWith('telegram'))).toBe('unknown');
    expect(channelKindOf(lineWith('telegram'))).toBe('telegram');
  });
});

describe('channel copy has one spelling per channel, product-wide', () => {
  it('shared channels inherit their label from the console-wide home', () => {
    for (const k of ['wa', 'signal', 'imessage', 'sms', 'email', 'discord', 'x'] as const) {
      expect(CHANNEL_LABEL[k]).toBe(BASE_LABEL[k]);
    }
  });

  it('every fleet glyph kind is labeled', () => {
    for (const raw of ['telegram', 'linkedin', 'reddit', 'instagram', 'facebook', 'slack', 'teams']) {
      const kind = channelKindOf(lineWith(raw));
      expect(CHANNEL_LABEL[kind]).toBeTruthy();
    }
  });

  it('the fleet map no longer re-rolls transport copy or the legacy health key', () => {
    // The convergence is what let both hygiene allowlists drop this file; if a
    // future edit re-rolls either, the file needs its allowlist entry back and
    // this pin says so before the guard does.
    const src = readFileSync('console/src/components/fleet/channel-kind.ts', 'utf8');
    expect(src).not.toContain('WhatsApp');
    expect(src).not.toContain('health.whatsapp');
    expect(src).not.toContain('health?.whatsapp');
    const registry = readFileSync('scripts/lib/fitness/registry.ts', 'utf8');
    expect(registry).not.toContain('console/src/components/fleet/channel-kind.ts');
  });
});
