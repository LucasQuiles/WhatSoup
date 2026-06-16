import { describe, expect, it } from 'vitest';
import { resolveDistillModel } from '../../../src/runtimes/agent/handoff-distill-model.ts';

describe('resolveDistillModel', () => {
  it('resolves a deepseek model to the deepseek endpoint + key from env', () => {
    const res = resolveDistillModel('deepseek-chat', { DEEPSEEK_API_KEY: 'sk-deep' });
    expect(res).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey: 'sk-deep',
    });
  });

  it('resolves a minimax model to the minimax chat-completions endpoint', () => {
    const res = resolveDistillModel('MiniMax-M2.7', { MINIMAX_API_KEY: 'mm-key' });
    expect(res?.provider).toBe('minimax');
    expect(res?.endpoint).toBe('https://api.minimax.io/v1/text/chatcompletion_v2');
    expect(res?.apiKey).toBe('mm-key');
    // The literal model id is preserved for the request body.
    expect(res?.model).toBe('MiniMax-M2.7');
  });

  it('resolves a glm/z.ai model to the z.ai coding endpoint using ZAI_API_KEY', () => {
    const res = resolveDistillModel('glm-5.2', { ZAI_API_KEY: 'zai-key' });
    expect(res?.provider).toBe('zai');
    expect(res?.endpoint).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    expect(res?.apiKey).toBe('zai-key');
  });

  it('returns null for an unknown model even when keys are present', () => {
    expect(resolveDistillModel('gpt-4o-mini', { OPENAI_API_KEY: 'sk', DEEPSEEK_API_KEY: 'd' })).toBeNull();
  });

  it('returns null for a known model when its key is absent from env', () => {
    expect(resolveDistillModel('deepseek-chat', {})).toBeNull();
    expect(resolveDistillModel('deepseek-chat', { DEEPSEEK_API_KEY: '   ' })).toBeNull();
  });

  it('returns null for empty / nullish model ids', () => {
    expect(resolveDistillModel(null, { DEEPSEEK_API_KEY: 'd' })).toBeNull();
    expect(resolveDistillModel(undefined, { DEEPSEEK_API_KEY: 'd' })).toBeNull();
    expect(resolveDistillModel('   ', { DEEPSEEK_API_KEY: 'd' })).toBeNull();
  });

  it('is case-insensitive on the provider prefix', () => {
    const res = resolveDistillModel('DeepSeek-Reasoner', { DEEPSEEK_API_KEY: 'd' });
    expect(res?.provider).toBe('deepseek');
    expect(res?.model).toBe('DeepSeek-Reasoner');
  });
});
