/**
 * Tests for the per-harness catalogue resolver (CONFIG-MODEL-RENDER-SPEC.md).
 * Both underlying probes are injected; the module-level opencode cache is reset
 * between cases. nowMs is injected so the cache + as-of are deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveModelCatalogue,
  formatCaptureAsOf,
  __resetModelCatalogueCacheForTest,
} from '../../../src/runtimes/agent/model-catalogue-resolver.ts';

beforeEach(() => {
  __resetModelCatalogueCacheForTest();
});

const T0 = 1_000_000; // arbitrary fixed clock base

describe('formatCaptureAsOf', () => {
  it('renders "just now" under a minute, "Nm ago" under an hour, "Nh ago (stale)" beyond', () => {
    expect(formatCaptureAsOf(T0, T0 + 30_000)).toBe('just now');
    expect(formatCaptureAsOf(T0, T0 + 4 * 60_000)).toBe('4m ago');
    expect(formatCaptureAsOf(T0, T0 + 3 * 60 * 60_000)).toBe('3h ago (stale)');
  });
});

describe('resolveModelCatalogue — opencode-cli', () => {
  const okList = (ids: string[]) => vi.fn().mockResolvedValue({ status: 'ok', ids });

  it('returns ok with the opencode source label on a fresh probe and caches it', async () => {
    const listFn = okList(['minimax/MiniMax-M2', 'deepseek/deepseek-chat']);
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['minimax/MiniMax-M2', 'deepseek/deepseek-chat'],
      sourceLabel: 'opencode CLI',
      asOfLabel: 'just now',
    });
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it('serves the cache within TTL without re-spawning', async () => {
    const listFn = okList(['a', 'b']);
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0 + 30_000, listFn });
    expect(out.status).toBe('ok');
    expect(listFn).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('re-probes after the TTL expires', async () => {
    const listFn = okList(['a']);
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0 + 61_000, listFn });
    expect(listFn).toHaveBeenCalledTimes(2);
  });

  it('maps a probe timeout (no cache) to the timeout reason', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'timeout' });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: 'just now' });
  });

  it('maps a spawn-error (no cache) to probe-failed', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'spawn-error' });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'probe-failed' }, asOfLabel: 'just now' });
  });

  it('maps an empty probe (no cache) to empty', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'empty' });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' });
  });

  it('flags output with a space as unparseable (no cache)', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['| Model | ID |', 'Fable 5 claude-fable-5'] });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'unparseable' }, asOfLabel: 'just now' });
  });

  it('serves a stale cache (with disclosed age) when a later re-probe fails', async () => {
    const listFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['a', 'b'] })              // T0: fresh
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'timeout' });  // T0+5m: reprobe fails
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0 + 5 * 60_000, listFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['a', 'b'],
      sourceLabel: 'opencode CLI',
      asOfLabel: '5m ago',
    });
  });
});

describe('resolveModelCatalogue — claude-cli', () => {
  it('returns no-key when the anthropic key is absent', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'no-key' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' });
  });

  it('labels the org catalogue as its source, not "what this harness runs"', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['claude-opus-4-8', 'claude-sonnet-5'],
      sourceLabel: 'anthropic /v1/models (org catalogue)',
      asOfLabel: 'just now',
    });
  });

  it('maps credential-expired → credential-expired (benign self-healing transient)', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'credential-expired' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'credential-expired' }, asOfLabel: 'just now' });
  });

  it('maps unauthorized → key-rejected', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'unauthorized' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'key-rejected' }, asOfLabel: 'just now' });
  });

  it('maps timeout → timeout', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'timeout' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: 'just now' });
  });

  it('maps lookup-failed → lookup-failed', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'lookup-failed' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'lookup-failed' }, asOfLabel: 'just now' });
  });

  it('maps an HTTP-200 but EMPTY catalogue to unavailable/empty, never ok+empty — an empty successful fetch is untrustworthy, not "this org has zero models"', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: [] });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' });
  });
});

describe('resolveModelCatalogue — unadapted harness', () => {
  // codex-cli/gemini-cli were the "unadapted" example before Task B wired them
  // up below — a synthetic harness id keeps this case's intent (a genuinely
  // unhandled provider still names itself in the reason) unambiguous now that
  // both are real adapters.
  it('names the harness in a no-adapter reason', async () => {
    const out = await resolveModelCatalogue('unknown-harness', 'unknown', { nowMs: T0 });
    expect(out).toStrictEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'unknown-harness' },
      asOfLabel: 'just now',
    });
  });
});

describe('resolveModelCatalogue — openai', () => {
  it('returns ok with the openai source label on a fresh probe and caches it', async () => {
    const openaiFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['gpt-x'] });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['gpt-x'],
      sourceLabel: 'openai /v1/models',
      asOfLabel: 'just now',
    });
    expect(openaiFn).toHaveBeenCalledTimes(1);
  });

  it('openai adapter returns ids on success', async () => {
    const l = await resolveModelCatalogue('openai', '', { nowMs: 1, openaiFn: async () => ({ status: 'ok', ids: ['gpt-x'] }) });
    expect(l).toMatchObject({ status: 'ok', ids: ['gpt-x'] });
  });

  it('openai adapter fails open (no throw) on error', async () => {
    const l = await resolveModelCatalogue('openai', '', { nowMs: 1, openaiFn: async () => { throw new Error('503'); } });
    expect(l.status).toBe('unavailable'); // disclosed, not thrown
  });

  it('also resolves via the openai-api provider id (the live runtime.ts call-site string)', async () => {
    const openaiFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['gpt-x'] });
    const out = await resolveModelCatalogue('openai-api', '', { nowMs: T0, openaiFn });
    expect(out.status).toBe('ok');
  });

  it('serves the cache within TTL without re-fetching', async () => {
    const openaiFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['gpt-x'] });
    await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0 + 30_000, openaiFn });
    expect(out.status).toBe('ok');
    expect(openaiFn).toHaveBeenCalledTimes(1);
  });

  it('maps no-key to the no-key reason', async () => {
    const openaiFn = vi.fn().mockResolvedValue({ status: 'no-key' });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' });
  });

  it('maps a classified unauthorized failure to key-rejected', async () => {
    const openaiFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'unauthorized' });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'key-rejected' }, asOfLabel: 'just now' });
  });

  it('serves a stale cache (with disclosed age) when a later re-probe throws', async () => {
    const openaiFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['gpt-x'] })
      .mockRejectedValueOnce(new Error('network down'));
    await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0 + 5 * 60_000, openaiFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['gpt-x'],
      sourceLabel: 'openai /v1/models',
      asOfLabel: '5m ago',
    });
  });

  it('does NOT stale-serve on no-key even with a prior cache — a structural absence answers immediately', async () => {
    const openaiFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['gpt-x'] })
      .mockResolvedValueOnce({ status: 'no-key' });
    await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0 + 5 * 60_000, openaiFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' });
  });

  it('maps an HTTP-200 but EMPTY catalogue to unavailable/empty when there is no prior cache to fall back on', async () => {
    const openaiFn = vi.fn().mockResolvedValue({ status: 'ok', ids: [] });
    const out = await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' });
  });

  it('an empty fresh capture does NOT clobber a non-empty last-known-good cache — serves it stale, age disclosed, instead of blanking the catalogue', async () => {
    const openaiFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['gpt-x'] })
      .mockResolvedValueOnce({ status: 'ok', ids: [] })
      .mockResolvedValueOnce({ status: 'ok', ids: ['gpt-y'] });

    const first = await resolveModelCatalogue('openai', '', { nowMs: T0, openaiFn });
    expect(first).toStrictEqual({ status: 'ok', ids: ['gpt-x'], sourceLabel: 'openai /v1/models', asOfLabel: 'just now' });

    // Past TTL: the re-probe comes back ok+EMPTY. Must not overwrite the cache
    // or render a blank menu — serve the stale non-empty list, age disclosed.
    const second = await resolveModelCatalogue('openai', '', { nowMs: T0 + 5 * 60_000, openaiFn });
    expect(second).toStrictEqual({ status: 'ok', ids: ['gpt-x'], sourceLabel: 'openai /v1/models', asOfLabel: '5m ago' });

    // The empty result was never cached, so the NEXT re-probe still hits the
    // network — and a genuinely fresh non-empty result replaces the cache
    // normally, proving the empty response didn't corrupt anything.
    const third = await resolveModelCatalogue('openai', '', { nowMs: T0 + 10 * 60_000, openaiFn });
    expect(third).toStrictEqual({ status: 'ok', ids: ['gpt-y'], sourceLabel: 'openai /v1/models', asOfLabel: 'just now' });
    expect(openaiFn).toHaveBeenCalledTimes(3);
  });
});

describe('resolveModelCatalogue — codex-cli', () => {
  // VERIFIED 2026-07-20 (live `codex --help` on this host): no `models`
  // subcommand exists — `codex models` is parsed as a chat PROMPT, not a
  // listing command. No call site injects a codex fn (there is no dep slot
  // for one — see the seam comment on resolveCodex), so this no-adapter
  // reason is the ONLY reachable production behavior, not one branch of a
  // probe/cache path.
  it('names codex-cli in a no-adapter reason (the only reachable production behavior)', async () => {
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0 });
    expect(out).toStrictEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'codex-cli' },
      asOfLabel: 'just now',
    });
  });
});

describe('resolveModelCatalogue — gemini-cli', () => {
  // Per the reason-evidence comment on resolveGemini: official docs show model
  // selection as an in-session `/model manage|set` command, not a standalone
  // `gemini models` listing surface. No call site injects a gemini fn (there
  // is no dep slot for one), so this no-adapter reason is the ONLY reachable
  // production behavior, not one branch of a probe/cache path.
  it('names gemini-cli in a no-adapter reason (the only reachable production behavior)', async () => {
    const out = await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0 });
    expect(out).toStrictEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'gemini-cli' },
      asOfLabel: 'just now',
    });
  });
});
