// tests/transport/outbound-content-egress.test.ts
//
// #1783 — the send-seam content-egress gate. Per-path/per-fragment gates upstream
// can miss a sibling representation or a split payload; this proves the ONE
// convergence-point (the governor override at the Baileys socket sendMessage)
// redacts a raw provider-error BANNER before the wire, while delivering ambient
// prose about an error and all normal text unchanged (policy: positive-match-only
// + default-allow + redact-and-deliver, #1783).
//
// The banner classifier is INJECTED (dependency inversion — transport may not
// import runtimes). These tests wire the SAME concrete classifier the composition
// root uses (classifyStreamedProviderFailure), so they exercise the real verdict
// logic, not a stub. All banner/ambient fixtures were verified against it before
// this test was written.
import { describe, it, expect, vi } from 'vitest';
import {
  OutboundGovernor,
  wrapWithOutboundGovernor,
} from '../../src/transport/outbound-governor.ts';
import {
  adjudicateOutboundContent,
  OUTBOUND_PROVIDER_ERROR_PLACEHOLDER,
} from '../../src/transport/outbound-content-egress.ts';
import { classifyStreamedProviderFailure } from '../../src/runtimes/agent/failure-taxonomy.ts';

// A raw provider-error BANNER (the text IS the error) — must be redacted.
const BANNER = 'Failed to authenticate. Invalid authentication credentials.';
const BANNER_OPENER = 'Error: invalid api key provided by the provider.';
// AMBIENT prose that DISCUSSES an error — must be delivered untouched (QR-209).
const AMBIENT =
  'I tried to reach the provider but it said the API key was invalid — you may ' +
  'need to check whether your authentication credentials or OAuth token have ' +
  'expired, then let me know and I will retry the request for you right away.';
// A short, legitimate message that merely MENTIONS an auth phrase — the advisor's
// false-positive case; the shape principle keeps it deliverable.
const SHORT_LEGIT = 'That action needs auth required from an admin first.';
const NORMAL = 'Sure! The meeting is scheduled for 3pm tomorrow.';

// The injected classifier — identical to what main.ts wires in production.
const CLASSIFY = classifyStreamedProviderFailure;

function permissive(): ConstructorParameters<typeof OutboundGovernor>[0] {
  return {
    windowMs: 1000,
    maxPerWindow: 1000,
    maxWaitMs: 10,
    hardCeiling: 100000,
    hardCeilingWindowMs: 1000,
    globalMaxPerWindow: 1000,
    globalWindowMs: 1000,
  };
}

function fakeSock() {
  // Declare the (jid, content, ...rest) arity so `mock.calls[i]` is a typed tuple
  // and `[, sentContent]` destructures to the content arg (not `undefined`).
  return {
    sendMessage: vi.fn(async (_jid: string, _content: unknown, ..._rest: unknown[]) => ({
      key: { id: 'wa-1' },
    })),
  };
}

const IDENTITY = (jid: string) => jid;
const DEST = 'test-dest-0';

/** Wrap a fake sock with the governor + the injected content classifier. */
function wrapWired(sock: ReturnType<typeof fakeSock>, log?: { warn: (obj: unknown, msg?: string) => void }) {
  const gov = new OutboundGovernor(permissive());
  wrapWithOutboundGovernor(sock, {
    governor: gov,
    resolveDest: IDENTITY,
    log,
    classifyProviderBanner: CLASSIFY,
  });
}

describe('adjudicateOutboundContent (#1783 pure decision, injected classifier)', () => {
  it('redacts a raw provider-error banner (text replaced with placeholder)', () => {
    const d = adjudicateOutboundContent({ text: BANNER }, CLASSIFY);
    expect(d.redacted).toBe(true);
    expect((d.content as { text: string }).text).toBe(OUTBOUND_PROVIDER_ERROR_PLACEHOLDER);
    expect(d.kind).toBe('auth-required');
  });

  it('does NOT mutate the caller content object', () => {
    const original = { text: BANNER, mentions: ['mention-a'] };
    const d = adjudicateOutboundContent(original, CLASSIFY);
    expect(original.text).toBe(BANNER); // untouched
    expect((d.content as { mentions: string[] }).mentions).toEqual(['mention-a']); // preserved
  });

  it('delivers ambient prose about an error unchanged', () => {
    expect(adjudicateOutboundContent({ text: AMBIENT }, CLASSIFY).redacted).toBe(false);
  });

  it('delivers a short legit message that merely mentions an auth phrase', () => {
    expect(adjudicateOutboundContent({ text: SHORT_LEGIT }, CLASSIFY).redacted).toBe(false);
  });

  it('delivers normal text unchanged', () => {
    expect(adjudicateOutboundContent({ text: NORMAL }, CLASSIFY).redacted).toBe(false);
  });

  it('never touches non-text (media/null) content', () => {
    expect(adjudicateOutboundContent({ image: Buffer.from('x') }, CLASSIFY).redacted).toBe(false);
    expect(adjudicateOutboundContent(null, CLASSIFY).redacted).toBe(false);
  });
});

describe('wrapWithOutboundGovernor — send-seam content-egress (#1783 integration)', () => {
  it('redacts a banner at the convergence point before it reaches the wire', async () => {
    const sock = fakeSock();
    const log = { warn: vi.fn() };
    wrapWired(sock, log);
    await sock.sendMessage(DEST, { text: BANNER });
    const [, sentContent] = sock.sendMessage.mock.calls[0];
    expect((sentContent as { text: string }).text).toBe(OUTBOUND_PROVIDER_ERROR_PLACEHOLDER);
    expect(log.warn).toHaveBeenCalled();
  });

  it('redacts an error-opener banner too', async () => {
    const sock = fakeSock();
    wrapWired(sock);
    await sock.sendMessage(DEST, { text: BANNER_OPENER });
    const [, sentContent] = sock.sendMessage.mock.calls[0];
    expect((sentContent as { text: string }).text).toBe(OUTBOUND_PROVIDER_ERROR_PLACEHOLDER);
  });

  it('delivers ambient prose about an error UNCHANGED through the seam', async () => {
    const sock = fakeSock();
    wrapWired(sock);
    await sock.sendMessage(DEST, { text: AMBIENT });
    const [, sentContent] = sock.sendMessage.mock.calls[0];
    expect((sentContent as { text: string }).text).toBe(AMBIENT);
  });

  it('delivers normal text unchanged through the seam', async () => {
    const sock = fakeSock();
    wrapWired(sock);
    await sock.sendMessage(DEST, { text: NORMAL });
    const [, sentContent] = sock.sendMessage.mock.calls[0];
    expect((sentContent as { text: string }).text).toBe(NORMAL);
  });

  it('leaves media sends (no text) untouched', async () => {
    const sock = fakeSock();
    wrapWired(sock);
    const media = { image: Buffer.from('x'), caption: 'c' };
    await sock.sendMessage(DEST, media);
    const [, sentContent] = sock.sendMessage.mock.calls[0];
    expect(sentContent).toBe(media);
  });

  it('is inert (no redaction) when no classifier is injected — banner delivered as-is', async () => {
    // Guards the DI contract: an un-wired governor must not silently depend on a
    // default classifier. Proves the gate is OFF without the composition-root wiring.
    const gov = new OutboundGovernor(permissive());
    const sock = fakeSock();
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY });
    await sock.sendMessage(DEST, { text: BANNER });
    const [, sentContent] = sock.sendMessage.mock.calls[0];
    expect((sentContent as { text: string }).text).toBe(BANNER);
  });
});
