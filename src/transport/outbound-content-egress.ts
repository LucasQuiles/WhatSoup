// Outbound content-egress gate (#1783).
//
// Egress gates upstream adjudicate per-path and per-fragment, and none sits at
// the send seam — so a sibling representation or a split payload that upstream
// never classified reaches the user (issue #1783, two live-on-main proofs). This
// module is the ONE convergence-point content adjudication, applied inside
// `wrapWithOutboundGovernor` at the Baileys socket `sendMessage` override, where
// Tier A (`connection.sendMessage`), Tier B (MCP `sendRaw`/`sendMedia`) and
// Tier C (raw tools calling `getSock().sendMessage`) all converge.
//
// Policy (owner-ratified 2026-07-19, #1783): POSITIVE-MATCH ONLY + default-ALLOW
// + REDACT-and-deliver. Redaction fires only when the reused classifier
// `classifyStreamedProviderFailure` marks the text a `banner` — i.e. the matched
// provider-error evidence essentially IS the message (QR-209 shape principle:
// starts with a curated error opener AND length <= MAX_STREAMED_BANNER_LENGTH).
// `ambient` prose that merely DISCUSSES an error, and any non-matching text, are
// delivered unchanged: on the outbound channel a false suppression is permanent
// unrecoverable silence, so the bar to redact is deliberately high. Redaction
// replaces the text with a neutral placeholder (never fully silent) in a fresh
// copy — the caller's content object is never mutated.
//
// The banner classifier is INJECTED (dependency inversion), not imported: the
// battle-tested implementation is `classifyStreamedProviderFailure` in the
// runtimes layer, but `transport` may not import `runtimes` (ring boundary). The
// composition root (src/main.ts) wires the concrete classifier in via
// `ConnectionManager.setOutboundContentClassifier`. Reusing that classifier
// inherits its hard-won anti-false-positive discipline: the bare `401` substring
// is deliberately excluded (it caused a prior multi-day false storm), and a short
// legitimate message that merely mentions an auth phrase classifies as `ambient`
// (delivered), because the shape principle requires the message to START with the
// error, not just contain the phrase.

/**
 * Injected banner classifier — the transport-side contract for the runtimes
 * `classifyStreamedProviderFailure`. Returns `null` (deliver) or a verdict whose
 * `confidence` is `'banner'` (the text IS the error → redact) or `'ambient'`
 * (prose about an error → deliver).
 */
export type OutboundBannerClassifier = (
  text: string,
) => { kind: string; confidence: 'banner' | 'ambient' } | null;

/** Structured-log message emitted (once) when the seam redacts a banner. */
export const OUTBOUND_CONTENT_EGRESS_REDACTED_LOG =
  'outbound content-egress: raw provider-error banner redacted at send seam (#1783)';

/**
 * User-facing text delivered in place of a redacted raw provider-error dump.
 * Neutral and non-leaking: it signals a transient issue without exposing the raw
 * provider output, and — unlike a silent drop — leaves the conversation with a
 * visible turn.
 */
export const OUTBOUND_PROVIDER_ERROR_PLACEHOLDER =
  '⚠️ A temporary provider error occurred; its internal detail was withheld.';

export interface ContentEgressDecision {
  /** True iff the content was a text banner and has been redacted. */
  redacted: boolean;
  /** The content to actually send: a redacted copy when `redacted`, else the original reference. */
  content: unknown;
  /** The provider-failure kind that triggered redaction (for the structured log). */
  kind?: string;
}

/**
 * Adjudicate one outbound Baileys content object at the send seam, using the
 * INJECTED banner classifier. Only a send whose `text` is a provider-error BANNER
 * is redacted; everything else — ambient prose, normal text, and any non-`text`
 * shape (media/control) — passes through unchanged. Never mutates the input object.
 */
export function adjudicateOutboundContent(
  content: unknown,
  classifyBanner: OutboundBannerClassifier,
): ContentEgressDecision {
  if (content === null || typeof content !== 'object') return { redacted: false, content };
  const record = content as Record<string, unknown>;
  const text = record['text'];
  if (typeof text !== 'string') return { redacted: false, content };

  const verdict = classifyBanner(text);
  if (verdict?.confidence !== 'banner') return { redacted: false, content };

  // Redact into a fresh copy — preserve every other field (mentions, contextInfo,
  // …); never mutate the caller's object.
  return {
    redacted: true,
    content: { ...record, text: OUTBOUND_PROVIDER_ERROR_PLACEHOLDER },
    kind: verdict.kind,
  };
}
