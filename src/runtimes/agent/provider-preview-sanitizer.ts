// Back-compat re-export. The implementation moved to `src/lib` (lowest ring) so
// `src/core` guardrails can reuse it without a core → runtimes import boundary
// violation. Existing `./provider-preview-sanitizer.ts` importers are unchanged.
export { sanitizeProviderPreviewText, providerPreview } from '../../lib/provider-preview-sanitizer.ts';
