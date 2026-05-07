import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import type { LLMProvider } from '../providers/types.ts';

const log = createChildLogger('contradiction');

export interface ContradictionResult {
  existingId: string;
  relationship: 'contradiction' | 'entailment' | 'neutral';
  explanation: string;
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

function stripJsonFences(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenceMatch ? fenceMatch[1].trim() : raw;
}

export async function detectContradictions(
  provider: LLMProvider,
  newFact: FactLike,
  existingFacts: ExistingFactLike[],
): Promise<ContradictionResult[]> {
  if (existingFacts.length === 0) return [];

  const prompt = `NEW CLAIM: "${newFact.claim || newFact.text}"

EXISTING CLAIMS:
${existingFacts.map((f, i) => `[${i}] "${f.claim || f.text}" (id: ${f.id})`).join('\n')}`;

  let raw: string;
  try {
    const response = await provider.generate({
      model: config.models.validation,
      maxTokens: 500,
      systemPrompt: NLI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = response.content.trim();
  } catch (err) {
    log.warn({ err }, 'contradiction detection: LLM call failed');
    return [];
  }

  const jsonStr = stripJsonFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    log.warn({ raw: raw.slice(0, 200) }, 'contradiction detection: JSON parse failed');
    return [];
  }

  if (!Array.isArray(parsed)) return [];

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

  return results;
}
