// src/runtimes/agent/handoff-summarizer.ts
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

const SUMMARY_SYSTEM = 'Summarize the conversation below into <=120 words of durable context for an assistant resuming this chat. State facts, open tasks, and the user goal. No preamble.';

export function buildHandoffDistill(cfg: HandoffDistillConfig): () => Promise<DistillOutcome> {
  if (!cfg.apiKey) throw new HandoffSummarizerInertError(`handoff summarizer inert: no key for model ${cfg.model}`);
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  return async (): Promise<DistillOutcome> => {
    const msgs = cfg.loadMessages().slice(-cfg.verbatimN);
    // REDACT before composing the outbound body (third-party data boundary). Both
    // the message content AND the sender name cross to the external model — a
    // WhatsApp senderName is a real human name / phone, so it must be redacted too
    // (the literal 'Assistant'/'User' role labels are not user data and are left as-is).
    const corpus = msgs
      .map((m) => {
        const who = m.isFromMe
          ? 'Assistant'
          : (m.senderName?.trim() ? cfg.redact(m.senderName.trim()) : 'User');
        return `${who}: ${cfg.redact(m.content?.trim() ?? '')}`;
      })
      .filter((l) => l.split(': ').slice(1).join(': ').trim().length > 0)
      .join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await doFetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: 512, stream: false,
          messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: corpus }] }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`handoff summarizer HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>; usage?: { total_tokens?: number } };
      const msg = data.choices?.[0]?.message;
      const flat = (c: unknown) => (typeof c === 'string' ? c : '');
      // Reasoning models (glm/minimax) emit into reasoning_content — read both.
      const summary = `${flat(msg?.content)} ${flat(msg?.reasoning_content)}`.trim();
      if (!summary) throw new Error('handoff summarizer returned empty summary');
      return { summary, seededArtifacts: null, tokensUsed: data.usage?.total_tokens ?? 0 };
    } finally {
      clearTimeout(timer);
    }
  };
}
