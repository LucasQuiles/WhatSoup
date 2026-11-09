import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';

function session(provider: 'anthropic-api' | 'openai-api', model?: string) {
  // Prompt composition neither reads the database nor sends messages.
  return new SessionManager({
    db: {} as Database,
    messenger: {} as Messenger,
    chatJid: 'prompt-test@s.whatsapp.net',
    onEvent: vi.fn(),
    provider,
    model,
    configSystemPrompt: 'Keep replies concise.',
  });
}

describe('configured session identity in the system prompt', () => {
  it('distinguishes a compatible API adapter from its configured model', () => {
    const prompt = session('anthropic-api', 'compatible-model-v2').buildSystemPrompt();
    expect(prompt).toContain('Configured session route: adapter="anthropic-api"; model="compatible-model-v2".');
    expect(prompt).toContain('An API-compatible adapter does not establish the model vendor.');
    expect(prompt).toContain('These are configuration values, not independent verification of the serving model.');
    expect(prompt).toContain('Keep replies concise.');
  });

  it('keeps an unspecified model unknown instead of guessing from the adapter', () => {
    const prompt = session('anthropic-api').buildSystemPrompt();
    expect(prompt).toContain('Configured session route: adapter="anthropic-api"; model=null.');
    expect(prompt).toContain('If model is null, report that it is unspecified rather than guessing.');
  });

  it('reports the new session route without retaining the previous route', () => {
    const first = session('anthropic-api', 'compatible-model-v2').buildSystemPrompt();
    const second = session('openai-api', 'compatible-model-v3').buildSystemPrompt();
    expect(first).toContain('adapter="anthropic-api"; model="compatible-model-v2"');
    expect(second).toContain('adapter="openai-api"; model="compatible-model-v3"');
    expect(second).not.toContain('compatible-model-v2');
  });
});
