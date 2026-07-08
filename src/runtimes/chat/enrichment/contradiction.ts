import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { resolveModelRole } from '../../../lib/model-advisor.ts';
import type { LLMProvider } from '../providers/types.ts';
import { errorMessage } from '../../../lib/error-message.ts';
import { stripJsonFences } from '../../../lib/json-fences.ts';

const log = createChildLogger('contradiction');

export interface ContradictionResult {
  existingId: string;
  relationship: 'contradiction' | 'entailment' | 'neutral';
  explanation: string;
}

export type ContradictionDetectionStatus =
  | 'ok'
  | 'skipped_no_existing_facts'
  | 'llm_failed'
  | 'parse_failed'
  | 'invalid_response';

export interface ContradictionDetectionDetails {
  results: ContradictionResult[];
  status: ContradictionDetectionStatus;
  error?: string;
  rawLength?: number;
}

interface FactLike {
  claim?: string;
  text: string;
}

interface ExistingFactLike {
  id: string;
  claim?: string;
  text: string;
  score: number;
}

const NLI_SYSTEM_PROMPT = `You are a natural language inference (NLI) judge. Given a NEW claim and a list of EXISTING claims, classify each pair's relationship.

For each existing claim, output:
{
  "index": <index of the existing claim>,
  "relationship": "entailment" | "contradiction" | "neutral",
  "explanation": "brief reason"
}

Definitions:
- entailment: the new claim is logically consistent with and supports the existing claim
- contradiction: the new claim conflicts with the existing claim (they cannot both be true)
- neutral: the claims are about different topics or don't interact logically

Output ONLY a JSON array. No markdown.`;

export async function detectContradictions(
  provider: LLMProvider,
  newFact: FactLike,
  existingFacts: ExistingFactLike[],
): Promise<ContradictionResult[]> {
  const details = await detectContradictionsDetailed(provider, newFact, existingFacts);
  return details.results;
}

export async function detectContradictionsDetailed(
  provider: LLMProvider,
  newFact: FactLike,
  existingFacts: ExistingFactLike[],
): Promise<ContradictionDetectionDetails> {
  if (existingFacts.length === 0) {
    return { results: [], status: 'skipped_no_existing_facts' };
  }

  const prompt = `NEW CLAIM: "${newFact.claim || newFact.text}"

EXISTING CLAIMS:
${existingFacts.map((f, i) => `[${i}] "${f.claim || f.text}" (id: ${f.id})`).join('\n')}`;

  let raw: string;
  try {
    const response = await provider.generate({
      // Resolve symbolic model values (vendor:family:latest[-stable]) at point
      // of use; literal IDs pass through untouched. Never throws.
      model: await resolveModelRole(config.models.validation),
      maxTokens: 500,
      systemPrompt: NLI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = response.content.trim();
  } catch (err) {
    const message = errorMessage(err);
    log.warn({ err: message }, 'contradiction detection: LLM call failed');
    return { results: [], status: 'llm_failed', error: message };
  }

  const jsonStr = stripJsonFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    const message = errorMessage(err);
    log.warn({ err: message, rawLength: raw.length }, 'contradiction detection: JSON parse failed');
    return { results: [], status: 'parse_failed', error: message, rawLength: raw.length };
  }

  if (!Array.isArray(parsed)) {
    log.warn({ rawLength: raw.length, parsedType: typeof parsed }, 'contradiction detection: invalid response shape');
    return { results: [], status: 'invalid_response', rawLength: raw.length };
  }

  const results: ContradictionResult[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const index = typeof obj['index'] === 'number' ? obj['index'] : null;
    if (index === null || index < 0 || index >= existingFacts.length) continue;
    const relationship = obj['relationship'] as string;
    if (relationship !== 'contradiction') continue;

    results.push({
      existingId: existingFacts[index].id,
      relationship: 'contradiction',
      explanation: typeof obj['explanation'] === 'string' ? obj['explanation'] : '',
    });
  }

  return { results, status: 'ok', rawLength: raw.length };
}
