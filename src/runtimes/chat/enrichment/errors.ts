/**
 * P3.6-H1 shared base for the enrichment pipeline's two strict-mode
 * fail-closed error classes: `ValidationError` (validator.ts) and
 * `ExtractionError` (extractor.ts). Both are raised only when the caller
 * opts into `strict: true` AND an "ambiguous empty" is detected — a result
 * that cannot be distinguished from a legitimate "nothing to report" reply.
 * Legitimate semantic drops (grounded=false, below-threshold confidence,
 * model-replied-`[]`) never raise; see each module's call sites for the
 * full per-stage contract.
 *
 * Stage meanings (shared across both subclasses):
 * - `provider-call`: the LLM provider threw before returning a response.
 * - `json-parse`: the response body failed `JSON.parse`.
 * - `schema-shape`: the parsed top-level is not a JSON array.
 * - `schema-items-all-dropped`: parsed array is non-empty but 100% of
 *   entries were schema-invalid (missing required field, wrong type, etc).
 *
 * `ValidationError` and `ExtractionError` are separate subclasses (not one
 * class with a runtime discriminator) specifically so `instanceof
 * ValidationError` / `instanceof ExtractionError` keep narrowing to exactly
 * one class — see the `strict && err instanceof ExtractionError` /
 * `instanceof ValidationError` dispatch in scripts/backfill-enrichment.ts.
 * Each subclass bakes its own `source` label into its constructor, so
 * existing callers pass no new argument.
 */
export type EnrichmentErrorStage =
  | 'provider-call'
  | 'json-parse'
  | 'schema-shape'
  | 'schema-items-all-dropped';

export interface EnrichmentErrorDetails {
  cause?: Error;
  rawOutput?: string;
  droppedCount?: number;
  totalCount?: number;
  sampleItem?: unknown;
}

export abstract class EnrichmentError extends Error {
  public readonly stage: EnrichmentErrorStage;
  public readonly details: EnrichmentErrorDetails;

  protected constructor(
    source: string,
    stage: EnrichmentErrorStage,
    details: EnrichmentErrorDetails = {},
  ) {
    super(`${source} failed: ${stage}`);
    this.stage = stage;
    this.details = details;
  }
}
