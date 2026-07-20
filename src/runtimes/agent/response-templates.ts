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
  /**
   * When true, the replay was blocked because the first attempt already started
   * an action. The reason templates then render the {@link toolActivityBlockedClause}
   * directive in place of the continue/resend clause, so the copy lives here
   * rather than being composed at the call site.
   */
  blockedByToolActivity?: boolean;
}

export interface AutoSwitchNoticeView {
  from: string | null;
  to: string;
  reason: string;
}

/**
 * Directive shown when a replay is blocked because the first attempt already
 * started an action. The stand-in will not replay it automatically; the user
 * must confirm or resend. This is the single source of truth for that copy.
 */
function toolActivityBlockedClause(): string {
  return 'The first attempt already started an action, so I will not replay it automatically. '
    + 'Please confirm or resend the next step.';
}

function etaClause(ctx: RenderContext): string {
  const reset = ctx.bundle?.resetAt ?? ctx.activeUntil ?? null;
  return reset !== null ? ` until about ${ctx.formatClock(reset)}` : '';
}

function continuationClause(ctx: RenderContext): string {
  if (ctx.blockedByToolActivity) return toolActivityBlockedClause();
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
    case 'tool-activity-blocked':
      // Standalone rendering: the reason-context clauses (backup/digest) precede
      // the blocked directive, which replaces the continue/resend clause.
      return `${backup}${digest} ${toolActivityBlockedClause()}`.trimStart();
    case 'none':
      return '';
  }
}

export function autoSwitchNoticeMessage(notice: AutoSwitchNoticeView): string {
  const source = notice.from ? ` from ${notice.from}` : '';
  const reason = notice.reason === 'high-demand'
    ? 'high demand'
    : notice.reason.replace(/-/g, ' ');
  return `_Model auto-switched${source} to ${notice.to} (${reason}). Continuing normally._`;
}

/**
 * Terminal notice for an UNCLASSIFIED terminal provider error (is_error result,
 * no recognised failure class) after automatic recovery has been exhausted —
 * the fallback net (maybeArmFallbackAfterUnknownTerminal) has either armed and
 * this is the below-threshold case or no eligible fallback exists. The ops alert
 * DOES fire on this path (provider_unknown_terminal), so the "alerted" claim is
 * backed. Deliberately drops the "try again / /new" advice: this is a terminal
 * fault, retry does not resolve it (contrast providerTransientRetryNotice).
 */
export function providerUnknownTerminalNotice(): string {
  return '_I couldn’t complete that and automatic recovery failed. An operator has been alerted._';
}

/**
 * Notice for a TRANSIENT provider connection drop — recoverable, the next
 * message respawns the session. Retry IS the correct remedy here, so this copy
 * asks the user to resend and, unlike the unknown-terminal notice, makes no
 * "operator alerted" claim (only a non-paging WARNING fires on this path).
 */
export function providerTransientRetryNotice(): string {
  return '_I hit a temporary connection problem — please resend and it should go through._';
}

/**
 * Class-appropriate notice for a provider SERVER-ERROR terminal result on the
 * no-fallback path. Distinct from {@link providerUnknownTerminalNotice}: a
 * server error is a transient backend fault (resend can succeed), and NO ops
 * alert fires on that path — so this copy names the transient cause and asks the
 * user to resend WITHOUT claiming an operator was notified. Wired at the
 * server-error no-fallback sites in runtime-turn-result-handler.ts.
 */
export function providerServerErrorNoFallbackNotice(): string {
  return "_The model backend had a temporary error and automatic retry didn't recover — please resend shortly._";
}
