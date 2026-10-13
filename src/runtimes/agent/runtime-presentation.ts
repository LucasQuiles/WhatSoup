/**
 * Pure presentation and fallback-classification helpers lifted out of
 * `runtime.ts` (module-level, no `this`, no runtime state).
 *
 * `runtime.ts` is the repo's largest grandfathered `arch.file-size` file and had
 * reached its ratchet ceiling exactly, so any change touching it was blocked.
 * These functions were the cleanest slice: none is re-exported, none appears in
 * `docs/public-surface.md`, and each is a total function of its arguments.
 */
import type { UserTemplateId } from './response-registry.ts';
import type { ProviderFallbackReason } from './runtime-turn-result-handler.ts';

export function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'claude-cli': return 'Claude';
    case 'codex-cli': return 'Codex';
    case 'gemini-cli': return 'Gemini';
    case 'opencode-cli': return 'OpenCode';
    case 'openai-api': return 'OpenAI';
    case 'anthropic-api': return 'Anthropic';
    default: return provider;
  }
}

export function modelCardLabel(provider: string, model: string | undefined): string {
  const providerName = providerDisplayName(provider);
  return model && model.trim() ? `${providerName} / ${model.trim()}` : providerName;
}

export function formatClockForUser(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * B26 human-scaled token count: 96_200 → '96.2k', 150_000 → '150k', 500 → '500'.
 * Same >1000 → one-decimal 'k' formula the /sessions handler inlines, plus a
 * trailing-'.0' strip so round budgets render '150k', not '150.0k'. The
 * /sessions inline sites keep their exact pre-B26 output ('2.0k') — do not
 * swap them onto this helper without updating their pinned renders.
 */
export function formatTokenCount(count: number): string {
  return count > 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(count);
}

// ── Background handoff-distiller sweep tuning (all gated behind the flag) ──────
// One periodic sweep enumerates active conversations and asks the runner to
// (maybe) distill each. The runner+gate own growth/budget/breaker/concurrency,
// so the interval only sets how often that machinery is consulted.
/** Narrow an arbitrary (possibly null) string to a ProviderFallbackReason. */
export function isProviderFallbackReason(value: unknown): value is ProviderFallbackReason {
  return value === 'usage-limit' || value === 'rate-limit'
    || value === 'auth-required' || value === 'model-unavailable'
    || value === 'server-error' || value === 'empty-output'
    || value === 'probe-unusable' || value === 'unknown-terminal-repeated';
}

export function fallbackRequiresPrimaryProbe(reason: ProviderFallbackReason): boolean {
  // Every automatic return to the primary needs fresh independent evidence.
  // The failure reason can affect fallback selection, but elapsed time alone
  // never proves that the primary is healthy again.
  void reason;
  return true;
}

export function templateForFallbackReason(reason: ProviderFallbackReason): UserTemplateId {
  // empty-output / probe-unusable / unknown-terminal-repeated are transient
  // primary failovers from the user's perspective (no hard auth/usage fault) —
  // they reuse the existing 'transient' user copy rather than minting new
  // user-facing templates (#1421).
  if (
    reason === 'server-error'
    || reason === 'empty-output'
    || reason === 'probe-unusable'
    || reason === 'unknown-terminal-repeated'
  ) {
    return 'transient';
  }
  return reason;
}
