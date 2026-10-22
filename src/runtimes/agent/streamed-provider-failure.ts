import { createChildLogger } from '../../logger.ts';
import { classifyStreamedProviderFailure, MAX_STREAMED_BANNER_LENGTH, type ProviderFailureKind } from './failure-taxonomy.ts';
import { providerPreview } from './provider-preview-sanitizer.ts';

// Same component binding as runtime.ts, so these log lines keep their fields.
const log = createChildLogger('agent-runtime');

/**
 * Two-tier gate for provider-failure text that streamed as assistant_text (QR-209).
 * The permissive `classifyProviderFailure` suppression used to drop ANY match,
 * silently discarding genuine replies that merely discussed an auth/limit error
 * (observed live: replies about an expired OAuth token dropped to silence). Now
 * only BANNER-confident matches (the text IS the error — short + error-opener /
 * usage-limit) are suppressed; AMBIENT matches (prose about an error) are let
 * through to the egress gate. Fallback is still armed only on the terminal
 * 'result' event, never here. Shared by both assistant_text handlers so their
 * suppression policy can't drift.
 *
 * Returns `{ suppress: true }` when THIS gate drops the chunk (caller must
 * `break`). Otherwise returns `{ suppress: false, ambient }`, where `ambient`
 * is non-null when the text matched a provider-failure token but was let
 * through as prose about an error, not the error itself — the caller must run
 * this result through the egress gate and log the ambient tripwire with that
 * gate's REAL outcome (#1758: logging "delivered" here fired one gate before
 * `gateAssistantTextForOutbound`, which can still suppress the same chunk for
 * an unrelated reason — a suppressed chunk logged as "delivered" is worse than
 * useless in incident forensics).
 */
export function suppressStreamedProviderFailure(
  normalizedText: string,
  chatJid: string | null,
): { suppress: boolean; ambient: { kind: ProviderFailureKind } | null } {
  const classification = classifyStreamedProviderFailure(normalizedText);
  if (classification === null) return { suppress: false, ambient: null };
  if (classification.confidence === 'banner') {
    log.warn(
      { chatJid, kind: classification.kind, textPreview: providerPreview(normalizedText, MAX_STREAMED_BANNER_LENGTH) },
      'suppressed provider-failure message from assistant_text',
    );
    return { suppress: true, ambient: null };
  }
  // Ambient: matched a provider-failure token but is prose about an error, not the
  // error itself. Dropping it is the QR-209 silent-reply defect, so this gate lets
  // it through — but the egress gate downstream can still suppress it for an
  // unrelated reason. The tripwire log therefore fires at the call site, after
  // that gate has run, tagged with its actual outcome.
  return { suppress: false, ambient: { kind: classification.kind } };
}

/**
 * Logs the QR-209 ambient-provider-failure tripwire with the REAL post-egress-gate
 * outcome (#1758). `delivered` when the fleet should see a novel banner shape that
 * ought to become a suppressible opener instead; `suppressed` when an unrelated
 * egress-gate reason (ack_filler, internal_narration, ...) already handled it, so
 * forensics must not read this line as evidence of delivery.
 */
export function logAmbientProviderFailureOutcome(
  ambient: { kind: ProviderFailureKind } | null,
  normalizedText: string,
  chatJid: string | null,
  delivered: boolean,
): void {
  if (!ambient) return;
  log.warn(
    {
      chatJid,
      kind: ambient.kind,
      textLength: normalizedText.length,
      textPreview: providerPreview(normalizedText, MAX_STREAMED_BANNER_LENGTH),
      outcome: delivered ? 'delivered' : 'suppressed',
    },
    delivered
      ? 'delivered assistant_text despite provider-failure classification'
      : 'suppressed assistant_text despite provider-failure classification (egress gate)',
  );
}
