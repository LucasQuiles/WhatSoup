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
});

describe('resolveModelCatalogue — codex-cli', () => {
  // VERIFIED 2026-07-20 (live `codex --help` on this host): no `models`
  // subcommand exists — `codex models` is parsed as a chat PROMPT, not a
  // listing command. Production therefore never injects codexFn, so the real
  // default MUST be a design-time no-adapter, not a spawn attempt at a command
  // that isn't real (which would misreport as empty/probe-failed).
  it('names codex-cli in a no-adapter reason when no codexFn is injected (the real production default)', async () => {
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0 });
    expect(out).toStrictEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'codex-cli' },
      asOfLabel: 'just now',
    });
  });

  it('returns ok with the codex source label on a fresh probe and caches it', async () => {
    const codexFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['gpt-5-codex'] });
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0, codexFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['gpt-5-codex'],
      sourceLabel: 'codex CLI',
      asOfLabel: 'just now',
    });
    expect(codexFn).toHaveBeenCalledTimes(1);
  });

  it('serves the cache within TTL without re-spawning', async () => {
    const codexFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['gpt-5-codex'] });
    await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0, codexFn });
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0 + 30_000, codexFn });
    expect(out.status).toBe('ok');
    expect(codexFn).toHaveBeenCalledTimes(1);
  });

  it('once a codexFn IS injected, maps a spawn-error (no cache) to probe-failed — not no-adapter', async () => {
    const codexFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'spawn-error' });
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0, codexFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'probe-failed' }, asOfLabel: 'just now' });
  });

  it('serves a stale cache (with disclosed age) when a later re-probe fails', async () => {
    const codexFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['gpt-5-codex'] })
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'timeout' });
    await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0, codexFn });
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0 + 5 * 60_000, codexFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['gpt-5-codex'],
      sourceLabel: 'codex CLI',
      asOfLabel: '5m ago',
    });
  });
});

describe('resolveModelCatalogue — gemini-cli', () => {
  // Per the reason-evidence comment on resolveGemini: official docs show model
  // selection as an in-session `/model manage|set` command, not a standalone
  // `gemini models` listing surface — production never injects geminiFn, so
  // the real default MUST be a design-time no-adapter (same reasoning as
  // codex-cli above), never a spawn attempt at an unconfirmed command.
  it('names gemini-cli in a no-adapter reason when no geminiFn is injected (the real production default)', async () => {
    const out = await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0 });
    expect(out).toStrictEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'gemini-cli' },
      asOfLabel: 'just now',
    });
  });

  it('returns ok with the gemini source label on a fresh probe and caches it', async () => {
    const geminiFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['gemini-3-pro'] });
    const out = await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0, geminiFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['gemini-3-pro'],
      sourceLabel: 'gemini CLI',
      asOfLabel: 'just now',
    });
    expect(geminiFn).toHaveBeenCalledTimes(1);
  });

  it('maps an empty probe (no cache) to empty', async () => {
    const geminiFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'empty' });
    const out = await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0, geminiFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' });
  });

  it('serves a stale cache (with disclosed age) when a later re-probe fails', async () => {
    const geminiFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['gemini-3-pro'] })
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'spawn-error' });
    await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0, geminiFn });
    const out = await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0 + 5 * 60_000, geminiFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['gemini-3-pro'],
      sourceLabel: 'gemini CLI',
      asOfLabel: '5m ago',
    });
  });

  it('flags output with a space as unparseable (no cache)', async () => {
    const geminiFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['not a model id'] });
    const out = await resolveModelCatalogue('gemini-cli', 'gemini', { nowMs: T0, geminiFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'unparseable' }, asOfLabel: 'just now' });
  });
});
