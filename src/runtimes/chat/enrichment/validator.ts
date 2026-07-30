import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { resolveModelRole } from '../../../lib/model-advisor.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { StoredMessage } from '../../../core/messages.ts';
import type { ExtractedFact } from './extractor.ts';
import { truncateRaw } from './raw-output.ts';
import { stripJsonFences } from '../../../lib/json-fences.ts';

const log = createChildLogger('enrichment');



/**
 * P3.6-H1 strict-mode error for the validator stage.
 *
 * Raised by {@link validateFacts} only when the caller opts into `strict: true`
 * AND an "ambiguous empty" is detected. Critically, legitimate semantic drops
 * — `grounded=false` results and `adjustedConfidence < threshold` — are the
 * model's explicit "this fact isn't defensible" signal and never raise.
 *
 * Intentionally no shared base class with ExtractionError — each module stays
 * self-contained. Future callers handle both types via separate `instanceof`
 * branches (see backfill-enrichment.ts).
 */
export class ValidationError extends Error {
  public readonly stage:
    | 'provider-call'
    | 'json-parse'
    | 'schema-shape'
    | 'schema-items-all-dropped';
  public readonly details: {
    cause?: Error;
    rawOutput?: string;
    droppedCount?: number;
    totalCount?: number;
    sampleItem?: unknown;
  };

  constructor(
    stage:
      | 'provider-call'
      | 'json-parse'
      | 'schema-shape'
      | 'schema-items-all-dropped',
    details: {
      cause?: Error;
      rawOutput?: string;
      droppedCount?: number;
      totalCount?: number;
      sampleItem?: unknown;
    } = {},
  ) {
    super(`validation failed: ${stage}`);
    this.stage = stage;
    this.details = details;
    this.name = 'ValidationError';
  }
}

export interface ValidateFactsOptions {
  /**
   * P3.6-H1. When true, ambiguous-empty results raise {@link ValidationError}
   * instead of silently dropping to `[]`. Semantic drops (grounded=false,
   * adjustedConfidence below `enrichmentMinConfidence`) stay silent even in
   * strict mode — those are legitimate model signals.
   *
   * @default false
   */
  strict?: boolean;
}

export interface ValidatedFact extends ExtractedFact {
  adjustedConfidence: number;
  validationReason?: string;
}

function buildValidationPrompt(facts: ExtractedFact[], messages: StoredMessage[]): string {
  const formattedMessages = messages
    .map((m) => {
      const ts = new Date(m.timestamp * 1000).toISOString();
      const name = m.senderName ?? m.senderJid;
      const content = m.content ?? '[non-text]';
      return `[${ts}] ${name}: ${content}`;
    })
    .join('\n');

  const factsJson = facts.map((f, i) => ({
    index: i,
    text: f.text,
    memory_type: f.memoryType,
  }));

  return `You are a fact validator. For each fact below, check if it is grounded in the source messages.

Facts to validate:
${JSON.stringify(factsJson, null, 2)}

Source messages:
${formattedMessages}

For each fact output a JSON object with:
{
  "index": <same index>,
  "grounded": true/false,
  "adjusted_confidence": 0.0-1.0,
  "reason": "brief explanation"
}

Output ONLY a JSON array, one entry per fact. No markdown.`;
}

export async function validateFacts(
  provider: LLMProvider,
  facts: ExtractedFact[],
  sourceMessages: StoredMessage[],
  options: ValidateFactsOptions = {},
): Promise<ValidatedFact[]> {
  const strict = options.strict === true;

  if (facts.length === 0) return [];

  let raw: string;
  try {
    const response = await provider.generate({
      // Resolve symbolic model values (vendor:family:latest[-stable]) at point
      // of use; literal IDs pass through untouched. Never throws.
      model: await resolveModelRole(config.models.validation),
      maxTokens: 1000,
      systemPrompt: 'You are a fact validator. Output only JSON arrays.',
      messages: [{ role: 'user', content: buildValidationPrompt(facts, sourceMessages) }],
    });
    raw = response.content.trim();
  } catch (err) {
    if (strict) {
      log.error(
        { stage: 'provider-call', factCount: facts.length },
        'validateFacts: strict-mode provider-call failure',
      );
      throw new ValidationError('provider-call', {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
    log.warn({ err, factCount: facts.length }, 'validateFacts: LLM unavailable — dropping all facts');
    return [];
  }

  const jsonStr = stripJsonFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    if (strict) {
      log.error(
        { stage: 'json-parse', factCount: facts.length },
        'validateFacts: strict-mode json-parse failure',
      );
      throw new ValidationError('json-parse', { rawOutput: truncateRaw(raw) });
    }
    log.warn({ raw: raw.slice(0, 200), factCount: facts.length }, 'validateFacts: LLM unavailable — dropping all facts');
    return [];
  }

  if (!Array.isArray(parsed)) {
    if (strict) {
      log.error(
        { stage: 'schema-shape', factCount: facts.length },
        'validateFacts: strict-mode schema-shape failure',
      );
      throw new ValidationError('schema-shape', { rawOutput: truncateRaw(raw) });
    }
    log.warn({ factCount: facts.length }, 'validateFacts: LLM unavailable — dropping all facts');
    return [];
  }

  // P3.6-H1: schema-based drops (non-object items, items missing required
  // `index`) are distinct from semantic drops (grounded=false, below-threshold).
  // Only schema drops count toward the 100%-throw gate.
  let schemaDrop = 0;
  let firstDroppedSample: unknown = undefined;
  const noteSchemaDrop = (sample: unknown) => {
    if (firstDroppedSample === undefined) firstDroppedSample = sample;
    schemaDrop += 1;
  };

  // Build a lookup from index -> validation result
  const resultMap = new Map<number, { grounded: boolean; adjustedConfidence: number; reason: string }>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      noteSchemaDrop(item);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const index = typeof obj['index'] === 'number' ? obj['index'] : null;
    if (index === null) {
      // Missing required `index` field — schema failure, not a semantic drop.
      noteSchemaDrop(item);
      continue;
    }
    const grounded = obj['grounded'] === true;
    const adjustedConfidence =
      typeof obj['adjusted_confidence'] === 'number'
        ? Math.max(0, Math.min(1, obj['adjusted_confidence']))
        : facts[index]?.confidence ?? 0;
    const reason = typeof obj['reason'] === 'string' ? obj['reason'] : '';
    resultMap.set(index, { grounded, adjustedConfidence, reason });
  }

  // P3.6-H1: ambiguous-empty gate. If the model returned items but every item
  // failed schema (100%-schema-drop), in strict mode we raise before building
  // the validated list. An empty `[]` response is legitimate and flows through
  // as pass-through on original confidence.
  if (strict && parsed.length > 0 && schemaDrop === parsed.length) {
    log.error(
      {
        stage: 'schema-items-all-dropped',
        factCount: facts.length,
        droppedCount: schemaDrop,
        totalCount: parsed.length,
      },
      'validateFacts: strict-mode all-items-schema-dropped',
    );
    throw new ValidationError('schema-items-all-dropped', {
      droppedCount: schemaDrop,
      totalCount: parsed.length,
      sampleItem: firstDroppedSample,
    });
  }

  const validated: ValidatedFact[] = [];
  for (let i = 0; i < facts.length; i++) {
    const result = resultMap.get(i);
    if (!result) {
      // Validation result missing for this fact — pass through with original confidence.
      validated.push({ ...facts[i], adjustedConfidence: facts[i].confidence, validationReason: '' });
      continue;
    }

    // P3.6-H1: these two drops are LEGITIMATE SEMANTIC signals from the model,
    // not schema failures — strict mode leaves them silent.
    if (!result.grounded) continue;
    if (result.adjustedConfidence < config.enrichmentMinConfidence) continue;

    validated.push({
      ...facts[i],
      adjustedConfidence: result.adjustedConfidence,
      validationReason: result.reason,
    });
  }

  return validated;
}
