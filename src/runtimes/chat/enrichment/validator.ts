import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { StoredMessage } from '../../../core/messages.ts';
import type { ExtractedFact } from './extractor.ts';

const log = createChildLogger('enrichment');

export interface ValidatedFact extends ExtractedFact {
  adjustedConfidence: number;
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
): Promise<ValidatedFact[]> {
  if (facts.length === 0) return [];

  let raw: string;
  try {
    const response = await provider.generate({
      model: config.models.validation,
      maxTokens: 1000,
      systemPrompt: 'You are a fact validator. Output only JSON arrays.',
      messages: [{ role: 'user', content: buildValidationPrompt(facts, sourceMessages) }],
    });
    raw = response.content.trim();
  } catch (err) {
    log.warn({ err, factCount: facts.length }, 'validateFacts: LLM unavailable — dropping all facts');
    return [];
  }

  // Strip markdown code fences if present
  let jsonStr = raw;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    log.warn({ raw: raw.slice(0, 200), factCount: facts.length }, 'validateFacts: LLM unavailable — dropping all facts');
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn({ factCount: facts.length }, 'validateFacts: LLM unavailable — dropping all facts');
    return [];
  }

  // Build a lookup from index -> validation result
  const resultMap = new Map<number, { grounded: boolean; adjustedConfidence: number }>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const index = typeof obj['index'] === 'number' ? obj['index'] : null;
    if (index === null) continue;
    const grounded = obj['grounded'] === true;
    const adjustedConfidence =
      typeof obj['adjusted_confidence'] === 'number'
        ? Math.max(0, Math.min(1, obj['adjusted_confidence']))
        : facts[index]?.confidence ?? 0;
    resultMap.set(index, { grounded, adjustedConfidence });
  }

  const validated: ValidatedFact[] = [];
  for (let i = 0; i < facts.length; i++) {
    const result = resultMap.get(i);
    if (!result) {
      // Validation result missing for this fact — pass through with original confidence
      validated.push({ ...facts[i], adjustedConfidence: facts[i].confidence });
      continue;
    }

    if (!result.grounded) continue;
    if (result.adjustedConfidence < config.enrichmentMinConfidence) continue;

    validated.push({ ...facts[i], adjustedConfidence: result.adjustedConfidence });
  }

  return validated;
}
