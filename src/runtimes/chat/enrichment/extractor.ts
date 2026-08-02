import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { resolveModelRole } from '../../../lib/model-advisor.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { StoredMessage } from '../../../core/messages.ts';
import { truncateRaw } from './raw-output.ts';
import { stripJsonFences } from '../../../lib/json-fences.ts';
import { EnrichmentError, type EnrichmentErrorStage, type EnrichmentErrorDetails } from './errors.ts';

const log = createChildLogger('enrichment');



/**
 * P3.6-H1 strict-mode error.
 *
 * Raised by {@link extractFacts} only when the caller opts into `strict: true`
 * AND an "ambiguous empty" is detected — i.e. an empty result that cannot be
 * distinguished from a legitimate "no facts" reply. A legitimate empty (model
 * returned `[]`, or no input messages) never raises. The `schema-items-all-dropped`
 * stage catches the 2026-04-18 regression where qwen3:32b-tuned returned
 * `[{"fact":"..."}]`.
 *
 * See {@link EnrichmentError} for the shared stage contract and why this
 * stays a distinct subclass rather than a discriminated single class.
 */
export class ExtractionError extends EnrichmentError {
  constructor(stage: EnrichmentErrorStage, details: EnrichmentErrorDetails = {}) {
    super('extraction', stage, details);
    this.name = 'ExtractionError';
  }
}

export interface ExtractFactsOptions {
  /**
   * P3.6-H1. When true, "ambiguous empty" results raise {@link ExtractionError}
   * instead of silently coercing to `[]`. Legitimate empties (empty batch,
   * model-replied-`[]`) still return `[]` silently.
   *
   * @default false
   */
  strict?: boolean;
}

export interface ExtractedFact {
  text: string;
  chatJid: string;
  senderJid: string;
  senderName: string;
  memoryType: 'user_fact' | 'group_context' | 'preference' | 'correction' | 'self_fact';
  confidence: number;
  supersedesText: string;
  sourceMessagePks: number[];
  claim?: string;
  evidence?: string;
  warrant?: string;
  confidenceQualifier?: string;
}

const EXTRACTION_SYSTEM_PROMPT = `You are an extraction engine. Given a batch of WhatsApp messages, extract factual information about the participants.

For each fact, output a JSON object:
{
  "text": "description of the fact",
  "claim": "the durable assertion being made",
  "evidence": "the exact words or context from the conversation supporting this claim",
  "warrant": "the reasoning connecting the evidence to the claim",
  "confidence_qualifier": "always | usually | sometimes | stated once | inferred",
  "sender_jid": "JID of the person this fact is about",
  "sender_name": "display name",
  "memory_type": "user_fact | group_context | preference | correction | self_fact",
  "confidence": 0.0-1.0,
  "supersedes_text": "previous fact this replaces, if any"
}

Rules:
- Only extract what is explicitly stated or directly implied. No speculation.
- If someone says "I just moved to London", extract: user_fact, "Lives in London"
- If this contradicts prior knowledge, mark it as a correction with supersedes_text
- Confidence must reflect how clearly the fact was stated
- Skip greetings, filler, and small talk with no factual content
- Group dynamics: note recurring topics, relationships between participants, shared interests
- Messages from Loops (is_from_me) contain claims Loops made about itself. Extract these as self_fact with Loops' JID and name. Examples: "Loops said he lived in Montreal", "Loops mentioned he does freelance dev work". These ensure Loops maintains a consistent identity across conversations.
- "claim" is the durable assertion. "evidence" is the verbatim or paraphrased source. "warrant" explains the inference.
- confidence_qualifier describes epistemic strength: "always" for repeated/permanent facts, "usually" for habitual behavior, "sometimes" for occasional mentions, "stated once" for single mentions, "inferred" for indirect conclusions.

Output ONLY a JSON array. No markdown, no explanation.`;

function formatMessages(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const ts = new Date(m.timestamp * 1000).toISOString();
      const name = m.senderName ?? m.senderJid;
      const content = m.content ?? '[non-text]';
      const tag = m.isFromMe ? ' [is_from_me]' : '';
      return `[${ts}] ${name} (${m.senderJid})${tag}: ${content}`;
    })
    .join('\n');
}

export async function extractFacts(
  provider: LLMProvider,
  messages: StoredMessage[],
  options: ExtractFactsOptions = {},
): Promise<ExtractedFact[]> {
  const strict = options.strict === true;

  // Legitimate empty: no input to extract from.
  if (messages.length === 0) return [];

  const chatJid = messages[0].chatJid;
  const pks = messages.map((m) => m.pk);
  // QR-084: the JIDs of the bot's OWN (is_from_me) messages in this batch. A
  // `self_fact` is recalled GLOBALLY and must originate from a genuine bot
  // self-claim, but memory_type comes from a steerable LLM with only a prompt
  // instruction tying it to is_from_me. Deterministically downgrade any
  // self_fact whose attributed sender_jid is not an is_from_me sender here, so a
  // non-is_from_me (attacker-participant) message cannot poison the global
  // self-identity store. Parallel to the QR-041 cross-sender-attribution gate.
  const selfSenders = new Set(messages.filter((m) => m.isFromMe).map((m) => m.senderJid));
  const conversationLog = formatMessages(messages);

  let raw: string;
  try {
    const response = await provider.generate({
      // Resolve symbolic model values (vendor:family:latest[-stable]) at point
      // of use; literal IDs pass through untouched. Never throws.
      model: await resolveModelRole(config.models.extraction),
      maxTokens: 2000,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: conversationLog }],
    });
    raw = response.content.trim();
  } catch (err) {
    if (strict) {
      // P3.6-H1 — log before throw so operators see the failure in telemetry.
      log.error({ stage: 'provider-call' }, 'extractFacts: strict-mode provider-call failure');
      throw new ExtractionError('provider-call', {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
    log.warn({ err, chatJid }, 'extractFacts: LLM call failed');
    return [];
  }

  const jsonStr = stripJsonFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    if (strict) {
      log.error(
        { stage: 'json-parse' },
        'extractFacts: strict-mode json-parse failure',
      );
      throw new ExtractionError('json-parse', { rawOutput: truncateRaw(raw) });
    }
    log.warn({ chatJid, raw: raw.slice(0, 200) }, 'extractFacts: JSON parse failed');
    return [];
  }

  if (!Array.isArray(parsed)) {
    if (strict) {
      log.error(
        { stage: 'schema-shape' },
        'extractFacts: strict-mode schema-shape failure',
      );
      throw new ExtractionError('schema-shape', { rawOutput: truncateRaw(raw) });
    }
    log.warn({ chatJid }, 'extractFacts: response is not an array');
    return [];
  }

  const facts: ExtractedFact[] = [];
  // P3.6-H1: schema-based drops are tallied so strict mode can detect
  // 100%-schema-drop (the 2026-04-18 qwen3 silent-empty class) and raise.
  let schemaDrop = 0;
  let firstDroppedSample: unknown = undefined;

  const noteSchemaDrop = (sample: unknown) => {
    if (firstDroppedSample === undefined) firstDroppedSample = sample;
    schemaDrop += 1;
  };

  // QR-041: the LLM-supplied `sender_jid` is untrusted — it is derived from message
  // CONTENT, so crafted text can make the model attribute a poisoned fact to a victim
  // who is not even in the conversation. Only the actual senders of this batch are
  // trusted (the envelope `senderJid`, the same value the model is shown). Accept the
  // claimed sender_jid only when it matches a real batch sender; otherwise blank it so
  // the fact is stored unattributed rather than attributed to an arbitrary victim.
  const trustedSenders = new Set(messages.map((m) => m.senderJid).filter(Boolean));

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      noteSchemaDrop(item);
      continue;
    }
    const obj = item as Record<string, unknown>;

    const text = typeof obj['text'] === 'string' ? obj['text'] : null;
    const claimedSenderJid = typeof obj['sender_jid'] === 'string' ? obj['sender_jid'] : '';
    const senderJid = trustedSenders.has(claimedSenderJid) ? claimedSenderJid : '';
    // Drop the LLM-supplied name when the attribution itself was rejected (it named a
    // non-participant); keep it only alongside a validated sender.
    const senderName = senderJid && typeof obj['sender_name'] === 'string' ? obj['sender_name'] : senderJid;
    const rawType = typeof obj['memory_type'] === 'string' ? obj['memory_type'] : 'user_fact';
    const validTypes = ['user_fact', 'group_context', 'preference', 'correction', 'self_fact'] as const;
    let memoryType = (validTypes as readonly string[]).includes(rawType)
      ? (rawType as ExtractedFact['memoryType'])
      : 'user_fact';
    // QR-084: a self_fact is recalled globally as the bot's self-identity. Only
    // a genuine bot self-claim (attributed to an is_from_me sender in this batch)
    // may carry that privileged type; anything else is downgraded to a per-chat
    // user_fact so a steered LLM on attacker content cannot poison the global
    // self-identity store.
    if (memoryType === 'self_fact' && (!senderJid || !selfSenders.has(senderJid))) {
      log.warn(
        { chatJid, senderJid },
        'extractFacts: downgrading self_fact not attributed to an is_from_me sender (QR-084)',
      );
      memoryType = 'user_fact';
    }
    const confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0.5;
    const supersedesText =
      typeof obj['supersedes_text'] === 'string' ? obj['supersedes_text'] : '';
    const claim = typeof obj['claim'] === 'string' ? obj['claim'] : '';
    const evidence = typeof obj['evidence'] === 'string' ? obj['evidence'] : '';
    const warrant = typeof obj['warrant'] === 'string' ? obj['warrant'] : '';
    const confidenceQualifier =
      typeof obj['confidence_qualifier'] === 'string' ? obj['confidence_qualifier'] : '';

    if (!text) {
      // Missing required `text` field — schema failure, not a semantic drop.
      noteSchemaDrop(item);
      continue;
    }

    facts.push({
      text,
      chatJid,
      senderJid,
      senderName,
      memoryType,
      confidence: Math.max(0, Math.min(1, confidence)),
      supersedesText,
      sourceMessagePks: pks,
      claim,
      evidence,
      warrant,
      confidenceQualifier,
    });
  }

  // P3.6-H1: ambiguous-empty gate. Non-empty parsed input that produced zero
  // facts solely due to schema mismatches is the silent-failure class we must
  // fail-closed on. An empty parsed input (`[]`) is a legitimate model-replied-
  // empty and flows through as `[]`.
  //
  // Invariant: under the extraction prompt contract, no legitimate 100%-schema-drop
  // exists. Every drop counted here is structural (non-object, missing `text`,
  // etc). A well-formed model reply with zero facts uses the empty-array
  // short-circuit above, not this path. If a future prompt change introduces
  // items that can be legitimately 100% dropped for non-schema reasons, move
  // that filter above this gate.
  if (strict && parsed.length > 0 && schemaDrop === parsed.length) {
    log.error(
      {
        stage: 'schema-items-all-dropped',
        droppedCount: schemaDrop,
        totalCount: parsed.length,
      },
      'extractFacts: strict-mode all-items-schema-dropped',
    );
    throw new ExtractionError('schema-items-all-dropped', {
      droppedCount: schemaDrop,
      totalCount: parsed.length,
      sampleItem: firstDroppedSample,
    });
  }

  return facts;
}
