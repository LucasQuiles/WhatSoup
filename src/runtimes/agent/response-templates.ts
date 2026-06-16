/**
 * Deterministic user-message templates for the consolidated handoff notice.
 *
 * On a provider failure the user sees exactly ONE message that both informs
 * (status + best-estimate recovery + a compact diagnostics digest) and, when a
 * stand-in is taking over, carries the continuation. These renderers are the
 * single place that copy lives.
 *
 * Determinism is a hard requirement (the review asked for byte-stable output so
 * it can be snapshot-tested and de-duplicated): findings render in a fixed
 * order, there is no wall-clock read, and the only time formatting goes through
 * an INJECTED `formatClock` — `toLocaleTimeString` is locale/TZ-dependent and
 * would make output environment-specific. The runtime passes its locale
 * formatter; tests pass a fixed one.
 */

import type { DiagnosticBundle, UserTemplateId } from './response-registry.ts';

export interface RenderContext {
  /** True when a stand-in will continue the turn; false when the user must resend. */
  hasContinuation: boolean;
  /** Preformatted backup model card, e.g. "OpenCode / minimax", or null when none. */
  backupCard?: string | null;
  /** Fallback-window expiry (epoch ms), used for an ETA when no parsed reset exists. */
  activeUntil?: number | null;
  /** Diagnostics gathered for this failure; drives the compact digest + reset ETA. */
  bundle?: DiagnosticBundle | null;
  /** Injected, deterministic clock formatter (epoch ms → short local time). */
  formatClock: (epochMs: number) => string;
  /** When true, omit the trailing continuation clause (the caller appends its own directive). */
  suppressContinuation?: boolean;
}

function etaClause(ctx: RenderContext): string {
  const reset = ctx.bundle?.resetAt ?? ctx.activeUntil ?? null;
  return reset !== null ? ` until about ${ctx.formatClock(reset)}` : '';
}

function continuationClause(ctx: RenderContext): string {
  if (ctx.suppressContinuation) return '';
  return ctx.hasContinuation ? "I'll continue here." : 'Please resend your last message.';
}

/** Compact, non-noisy digest of how many checks passed vs were flagged. */
function diagnosticsDigest(ctx: RenderContext): string {
  const findings = ctx.bundle?.findings ?? [];
  if (findings.length === 0) return '';
  const ok = findings.filter((f) => f.ok).length;
  const flagged = findings.length - ok;
  return flagged > 0 ? ` (diagnostics: ${ok} ok, ${flagged} flagged)` : ` (diagnostics: ${ok} ok)`;
}

function backupClause(ctx: RenderContext): string {
  return ctx.backupCard ? ` Switching to ${ctx.backupCard}.` : '';
}

export function renderUserMessage(id: UserTemplateId, ctx: RenderContext): string {
  const eta = etaClause(ctx);
  const backup = backupClause(ctx);
  const digest = diagnosticsDigest(ctx);
  const cont = continuationClause(ctx);

  switch (id) {
    case 'usage-limit':
      return `Primary model hit a usage/quota limit${eta}.${backup}${digest} ${cont}`;
    case 'rate-limit':
      return `Primary model is rate limited${eta}.${backup}${digest} ${cont}`;
    case 'auth-required':
      return `Primary model needs re-auth.${backup}${digest} ${cont}`;
    case 'model-unavailable':
      return `Primary model is unavailable on this host.${backup}${digest} ${cont}`;
    case 'transient':
      return `Primary model hit a temporary error.${backup} ${cont}`;
    case 'context-overflow':
      return '_Context limit reached — starting fresh session. Send your message again._';
    case 'no-fallback':
      return `Primary model is temporarily unavailable${eta}.${digest} Please try again shortly.`;
    case 'credentials-missing':
      return 'Primary model is unavailable and the backup credentials look missing; an operator has been notified.';
    case 'exhausted':
      return `All configured models are temporarily unavailable${eta}. An operator has been notified; please try again shortly.`;
    case 'none':
      return '';
  }
}
