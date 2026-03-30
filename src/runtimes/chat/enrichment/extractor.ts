import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { StoredMessage } from '../../../core/messages.ts';

const log = createChildLogger('enrichment');

export interface ExtractedFact {
  text: string;
  chatJid: string;
  senderJid: string;
  senderName: string;
  memoryType: 'user_fact' | 'group_context' | 'preference' | 'correction' | 'self_fact';
  confidence: number;
  supersedesText: string;
  sourceMessagePks: number[];
}

const EXTRACTION_SYSTEM_PROMPT = `You are an extraction engine. Given a batch of WhatsApp messages, extract factual information about the participants.

For each fact, output a JSON object:
{
  "text": "description of the fact",
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
): Promise<ExtractedFact[]> {
  if (messages.length === 0) return [];

  const chatJid = messages[0].chatJid;
  const pks = messages.map((m) => m.pk);
  const conversationLog = formatMessages(messages);

  let raw: string;
  try {
    const response = await provider.generate({
      model: config.models.extraction,
      maxTokens: 2000,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: conversationLog }],
    });
    raw = response.content.trim();
  } catch (err) {
    log.warn({ err, chatJid }, 'extractFacts: LLM call failed');
    return [];
  }

  // Strip markdown code fences if present (LLMs sometimes wrap despite instructions)
  let jsonStr = raw;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    log.warn({ chatJid, raw: raw.slice(0, 200) }, 'extractFacts: JSON parse failed');
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn({ chatJid }, 'extractFacts: response is not an array');
    return [];
  }

  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;

    const text = typeof obj['text'] === 'string' ? obj['text'] : null;
    const senderJid = typeof obj['sender_jid'] === 'string' ? obj['sender_jid'] : '';
    const senderName = typeof obj['sender_name'] === 'string' ? obj['sender_name'] : senderJid;
    const rawType = typeof obj['memory_type'] === 'string' ? obj['memory_type'] : 'user_fact';
    const validTypes = ['user_fact', 'group_context', 'preference', 'correction', 'self_fact'] as const;
    const memoryType = (validTypes as readonly string[]).includes(rawType)
      ? (rawType as ExtractedFact['memoryType'])
      : 'user_fact';
    const confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0.5;
    const supersedesText =
      typeof obj['supersedes_text'] === 'string' ? obj['supersedes_text'] : '';

    if (!text) continue;

    facts.push({
      text,
      chatJid,
      senderJid,
      senderName,
      memoryType,
      confidence: Math.max(0, Math.min(1, confidence)),
      supersedesText,
      sourceMessagePks: pks,
    });
  }

  return facts;
}
