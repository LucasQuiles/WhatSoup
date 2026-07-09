import { describe, it, expect } from 'vitest';
import {
  OutboundFloodDetector,
  OUTBOUND_FLOOD_WINDOW_MS,
  OUTBOUND_FLOOD_THRESHOLD,
} from '../../src/transport/outbound-flood-detector.ts';
import { toConversationKey } from '../../src/core/conversation-key.ts';

// T1.1 — the sliding-window per-destination counter, mirrored on the
// `recentDisconnects` window in src/core/health.ts (window + count + threshold).
// A logical clock (explicit ts/now args) keeps the aging assertions deterministic
// without fake timers.
describe('OutboundFloodDetector — sliding window (T1.1)', () => {
  it('exposes the spec defaults (20 sends / 5 min)', () => {
    expect(OUTBOUND_FLOOD_WINDOW_MS).toBe(300_000);
    expect(OUTBOUND_FLOOD_THRESHOLD).toBe(20);
    const d = new OutboundFloodDetector();
    // stats() reports the configured window/threshold so pollers can read them.
    const s = d.stats(0);
    expect(s.windowMs).toBe(300_000);
    expect(s.threshold).toBe(20);
    expect(s.flooding).toBe(false);
  });

  it('trips isFlooding once threshold sends land inside the window', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 3 });
    const dest = '15551230000@s.whatsapp.net';
    d.record(dest, 0);
    d.record(dest, 10);
    expect(d.isFlooding(dest, 20)).toBe(false); // 2 < 3
    d.record(dest, 20);
    expect(d.isFlooding(dest, 30)).toBe(true); // 3 >= 3
    expect(d.count(dest, 30)).toBe(3);
  });

  it('does not trip when sends stay below threshold', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 3 });
    const dest = 'a@s.whatsapp.net';
    d.record(dest, 0);
    d.record(dest, 100);
    expect(d.isFlooding(dest, 200)).toBe(false);
    expect(d.count(dest, 200)).toBe(2);
  });

  it('ages entries out of the window so an old burst stops flooding', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 3 });
    const dest = 'a@s.whatsapp.net';
    d.record(dest, 0);
    d.record(dest, 1);
    d.record(dest, 2);
    expect(d.isFlooding(dest, 3)).toBe(true);
    // window is 1_000ms; by t=1_500 the t<=2 sends have all aged out.
    expect(d.isFlooding(dest, 1_500)).toBe(false);
    expect(d.count(dest, 1_500)).toBe(0);
  });

  it('keys distinct destinations independently', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 3 });
    d.record('a@s.whatsapp.net', 0);
    d.record('a@s.whatsapp.net', 1);
    d.record('a@s.whatsapp.net', 2);
    d.record('b@s.whatsapp.net', 2);
    expect(d.isFlooding('a@s.whatsapp.net', 3)).toBe(true);
    expect(d.isFlooding('b@s.whatsapp.net', 3)).toBe(false);
  });

  it('stats() reports the worst offender and distinct destination count', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 3 });
    d.record('a@s.whatsapp.net', 0);
    d.record('a@s.whatsapp.net', 1);
    d.record('a@s.whatsapp.net', 2);
    d.record('a@s.whatsapp.net', 3);
    d.record('b@s.whatsapp.net', 3);
    const s = d.stats(4);
    expect(s.flooding).toBe(true);
    expect(s.worstKey).toBe('a@s.whatsapp.net'); // raw key; redacted at the boundary
    expect(s.worstCount).toBe(4);
    expect(s.destCount).toBe(2);
  });
});

// T1.3 — lid-resolved dest keying (G2/H3). The seam wires in the ingest-parity
// resolver (`canonicalConversationKey`) so an `@lid` DM and its resolved phone
// JID fold onto ONE per-dest counter — a mid-stream JID flip can't reset the
// count and dodge the threshold. Here a fake resolver stands in for
// canonicalConversationKey (unit-isolated; the real wiring is covered at the seam).
describe('OutboundFloodDetector — lid-resolved keying (T1.3, G2/H3)', () => {
  const LID = '81536414179557@lid';
  const PHONE = '15551234567@s.whatsapp.net';
  const FOLDED = '15551234567'; // what the lid_mappings resolver yields for both
  const fold = (dest: string): string => (dest === LID ? FOLDED : toConversationKey(dest));

  it('folds @lid and phone-JID sends onto ONE destination counter', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 4, resolveKey: fold });
    d.record(LID, 0);
    d.record(LID, 1);
    d.record(PHONE, 2); // mid-stream flip from @lid to phone-JID addressing
    d.record(PHONE, 3);
    // 2 + 2 = 4 >= threshold — the flip did not dodge the trip.
    expect(d.isFlooding(LID, 4)).toBe(true);
    expect(d.isFlooding(PHONE, 4)).toBe(true);
    // Either raw address resolves to the same folded counter (== 4).
    expect(d.count(PHONE, 4)).toBe(4);
    expect(d.count(LID, 4)).toBe(4);
  });

  it('proves the fold is load-bearing: without the resolver the same flip DODGES the threshold', () => {
    const d = new OutboundFloodDetector({ windowMs: 1_000, threshold: 4 }); // identity keying
    d.record(LID, 0);
    d.record(LID, 1);
    d.record(PHONE, 2);
    d.record(PHONE, 3);
    // Split across two raw keys, neither reaches threshold — the dodge the
    // resolver closes.
    expect(d.isFlooding(LID, 4)).toBe(false);
    expect(d.isFlooding(PHONE, 4)).toBe(false);
  });
});
