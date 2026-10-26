import { z } from 'zod';
import type { DistillOutcome } from './handoff-distiller.ts';
import type { HandoffMessage } from './handoff-prelude.ts';

export class HandoffSummarizerInertError extends Error {}

export interface HandoffDistillConfig {
  model: string;
  apiKey: string;
  endpoint: string;
  conversationKey: string;
  loadMessages: () => HandoffMessage[];
  redact: (text: string) => string;
  verbatimN: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 4096;
const MAX_SUMMARY_WORDS = 120;
const SUMMARY_SYSTEM = 'Summarize the conversation below into <=120 words of durable context for an assistant resuming this chat. State facts, open tasks, and the user goal. No preamble.';
const summaryResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
  usage: z.object({ total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
});

async function readSummaryResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('handoff summarizer returned empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('handoff summarizer response exceeds byte limit');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
      throw new Error('handoff summarizer returned invalid JSON');
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function buildHandoffDistill(cfg: HandoffDistillConfig): () => Promise<DistillOutcome> {
  if (!cfg.apiKey) throw new HandoffSummarizerInertError(`handoff summarizer inert: no key for model ${cfg.model}`);
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  return async (): Promise<DistillOutcome> => {
    const msgs = cfg.loadMessages().slice(-cfg.verbatimN);
    // Refuse oversized stored input before trimming, redaction or JSON expansion.
    let inputBytes = 0;
    for (const message of msgs) {
      inputBytes += Buffer.byteLength(message.content ?? '') + Buffer.byteLength(message.senderName ?? '');
      if (inputBytes > MAX_REQUEST_BYTES) throw new Error('handoff summarizer request exceeds byte limit');
    }
    // Names and message content both cross the external-provider boundary.
    const lines: string[] = [];
    let corpusBytes = 0;
    for (const message of msgs) {
      const content = cfg.redact(message.content?.trim() ?? '');
      if (!content.trim()) continue;
      const who = message.isFromMe ? 'Assistant' : (message.senderName?.trim() ? cfg.redact(message.senderName.trim()) : 'User');
      const line = `${who}: ${content}`;
      corpusBytes += Buffer.byteLength(line) + 1;
      if (corpusBytes > MAX_REQUEST_BYTES) throw new Error('handoff summarizer request exceeds byte limit');
      lines.push(line);
    }
    const body = JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: 512, stream: false,
      messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: lines.join('\n') }] });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error('handoff summarizer request exceeds byte limit');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await doFetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body,
        redirect: 'error',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`handoff summarizer HTTP ${res.status}`);
      }
      const parsed = summaryResponse.safeParse(await readSummaryResponse(res));
      if (!parsed.success) throw new Error('handoff summarizer returned invalid response or token usage');
      // Provider reasoning is not user-facing content and must never be persisted.
      const summary = parsed.data.choices[0]?.message.content?.trim() ?? '';
      if (!summary) throw new Error('handoff summarizer returned empty summary');
      if (Buffer.byteLength(summary) > MAX_SUMMARY_BYTES || summary.split(/\s+/u).length > MAX_SUMMARY_WORDS) {
        throw new Error('handoff summarizer summary exceeds output limit');
      }
      return { summary, seededArtifacts: null, tokensUsed: parsed.data.usage.total_tokens };
    } finally {
      clearTimeout(timer);
    }
  };
}
