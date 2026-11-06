// #3717c: ContextGaugeStore contract (last DISTINCT request, replace-not-add, unknown, seal, generation).
import { describe, expect, it } from 'vitest';
import { ContextGaugeStore } from '../../../src/runtimes/agent/context-gauge.ts';

const S = 'chat@s.whatsapp.net';
const G = 'row:1';

describe('ContextGaugeStore', () => {
  it('is unknown before any request', () => {
    expect(new ContextGaugeStore().read(S, G)).toBeUndefined();
  });

  it('a repeated message id REPLACES its value and never adds', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 76_000);
    store.observeRequest(S, G, 'A', 76_000);
    store.observeRequest(S, G, 'A', 76_000);
    expect(store.read(S, G)).toBe(76_000);
  });

  it('the gauge is the last distinct request, not a sum of the turn', () => {
    const store = new ContextGaugeStore();
    for (const [id, tokens] of [['A', 70_000], ['B', 72_000], ['C', 76_000]] as const) {
      store.observeRequest(S, G, id, tokens);
    }
    expect(store.read(S, G)).toBe(76_000);
  });

  it('A/B/A: a late repeat of A after B does not make A current', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeRequest(S, G, 'B', 120_000);
    store.observeRequest(S, G, 'A', 100_000);
    expect(store.read(S, G)).toBe(120_000);
    // A's late repeat with a different (even larger) value still does not displace B.
    store.observeRequest(S, G, 'A', 900_000);
    expect(store.read(S, G)).toBe(120_000);
  });

  it('a repeat of the CURRENT id with unknown usage makes the gauge unknown', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeRequest(S, G, 'B', 120_000);
    store.observeRequest(S, G, 'B', undefined);
    expect(store.read(S, G)).toBeUndefined();
  });

  it('an id-less request is its own distinct request and becomes current', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeRequest(S, G, undefined, 50_000);
    expect(store.read(S, G)).toBe(50_000);
  });

  it('unknown usage on the last distinct request is unknown, with no fallback to an earlier one', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeRequest(S, G, 'B', undefined);
    expect(store.read(S, G)).toBeUndefined();
  });

  it('keeps the closed turn value until the next turn starts, which clears the earlier ids', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeResult(S, G);
    expect(store.read(S, G)).toBe(100_000);
    // A new turn whose first request reuses an old id is a fresh distinct request.
    store.observeRequest(S, G, 'A', 40_000);
    expect(store.read(S, G)).toBe(40_000);
  });

  it('a turn that produced no request leaves the gauge unknown, never a stale value', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeResult(S, G);
    store.observeResult(S, G); // next turn: result with no request_usage
    expect(store.read(S, G)).toBeUndefined();
  });

  it('compact_boundary seals: unknown and request usage ignored until the compact result', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 470_000);
    store.observeCompactBoundary(S, G);
    expect(store.read(S, G)).toBeUndefined();
    store.observeRequest(S, G, 'summary', 30_000); // summarize request after the boundary
    expect(store.read(S, G)).toBeUndefined();
    store.observeResult(S, G); // compact turn result unseals but stays unknown
    expect(store.read(S, G)).toBeUndefined();
    store.observeRequest(S, G, 'next', 31_000);
    expect(store.read(S, G)).toBe(31_000);
  });

  it('a different generation reads unknown and a write there starts fresh', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    expect(store.read(S, 'row:2')).toBeUndefined();
    store.observeRequest(S, 'row:2', 'B', 5_000);
    expect(store.read(S, 'row:2')).toBe(5_000);
    expect(store.read(S, G)).toBeUndefined();
  });

  it('init with a new provider session id resets; the same id keeps the gauge', () => {
    const store = new ContextGaugeStore();
    store.observeInit(S, G, 'sess-1');
    store.observeRequest(S, G, 'A', 100_000);
    store.observeResult(S, G);
    store.observeInit(S, G, 'sess-1');
    expect(store.read(S, G)).toBe(100_000);
    store.observeInit(S, G, 'sess-2');
    expect(store.read(S, G)).toBeUndefined();
  });

  it('first init after unbound usage drops it; the open turn closes unknown, then binds', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 450_000); // no init has bound a session yet
    store.observeInit(S, G, 'sess-2');
    expect(store.read(S, G)).toBeUndefined();
    store.observeResult(S, G); // never the unbound 450,000
    expect(store.read(S, G)).toBeUndefined();
    store.observeRequest(S, G, 'B', 40_000);
    store.observeResult(S, G);
    store.observeInit(S, G, 'sess-2'); // now bound: the same id keeps the gauge
    expect(store.read(S, G)).toBe(40_000);
  });

  it('first init mid-turn: a later request of the same turn is the known context', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 450_000);
    store.observeInit(S, G, 'sess-2');
    store.observeRequest(S, G, 'B', 60_000);
    store.observeResult(S, G);
    expect(store.read(S, G)).toBe(60_000);
  });

  it('first init during a compact seal keeps the seal through the compact result', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 470_000); // unbound
    store.observeCompactBoundary(S, G);
    store.observeInit(S, G, 'sess-1');
    expect(store.read(S, G)).toBeUndefined();
    store.observeRequest(S, G, 'summary', 30_000); // still sealed: ignored
    expect(store.read(S, G)).toBeUndefined();
    store.observeResult(S, G); // compact result unseals but stays unknown
    expect(store.read(S, G)).toBeUndefined();
    store.observeRequest(S, G, 'next', 31_000);
    expect(store.read(S, G)).toBe(31_000);
  });

  it('delete drops the scope; rekey moves it; clear drops all', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.rekey(S, 'alias@lid');
    expect(store.read(S, G)).toBeUndefined();
    expect(store.read('alias@lid', G)).toBe(100_000);
    store.delete('alias@lid');
    expect(store.read('alias@lid', G)).toBeUndefined();
    store.observeRequest(S, G, 'A', 1);
    store.clear();
    expect(store.read(S, G)).toBeUndefined();
  });

  it('scopes are independent', () => {
    const store = new ContextGaugeStore();
    store.observeRequest(S, G, 'A', 100_000);
    store.observeRequest('other', G, 'A', 7);
    expect(store.read(S, G)).toBe(100_000);
    expect(store.read('other', G)).toBe(7);
  });
});
