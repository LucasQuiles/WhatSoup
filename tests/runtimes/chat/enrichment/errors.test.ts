import { describe, it, expect } from 'vitest';
import { EnrichmentError } from '../../../../src/runtimes/chat/enrichment/errors.ts';
import { ValidationError } from '../../../../src/runtimes/chat/enrichment/validator.ts';
import { ExtractionError } from '../../../../src/runtimes/chat/enrichment/extractor.ts';

// Refs #2212: ValidationError and ExtractionError now share an EnrichmentError
// base, but scripts/backfill-enrichment.ts dispatches on
// `err instanceof ExtractionError` / `err instanceof ValidationError` in an
// if/else-if chain — the two must stay mutually exclusive, not merely both
// instances of the shared base.
describe('EnrichmentError subclass discrimination', () => {
  it('ValidationError is an EnrichmentError but not an ExtractionError', () => {
    const err = new ValidationError('json-parse', { rawOutput: 'not json {' });
    expect(err).toBeInstanceOf(EnrichmentError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(ExtractionError);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('validation failed: json-parse');
  });

  it('ExtractionError is an EnrichmentError but not a ValidationError', () => {
    const err = new ExtractionError('schema-shape', { rawOutput: '{}' });
    expect(err).toBeInstanceOf(EnrichmentError);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.name).toBe('ExtractionError');
    expect(err.message).toBe('extraction failed: schema-shape');
  });

  it('both subclasses carry stage and details through the shared base', () => {
    const sampleItem = { fact: 'wrong shape' };
    const err = new ExtractionError('schema-items-all-dropped', {
      droppedCount: 2,
      totalCount: 2,
      sampleItem,
    });
    expect(err.stage).toBe('schema-items-all-dropped');
    expect(err.details).toEqual({ droppedCount: 2, totalCount: 2, sampleItem });
  });
});
