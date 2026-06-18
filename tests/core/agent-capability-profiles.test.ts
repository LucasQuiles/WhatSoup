import { describe, expect, it } from 'vitest';
import {
  applyAgentCapabilityProfile,
  getAgentCapabilityProfile,
  isAgentCapabilityProfileId,
} from '../../src/core/agent-capability-profiles.ts';

function record(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-bot',
    type: 'agent',
    adminPhones: ['15551234567'],
    accessMode: 'self_only',
    agentProfile: 'max-capability-research',
    ...overrides,
  };
}

describe('agent capability profiles', () => {
  it('exposes a stable max-capability-research profile id', () => {
    expect(isAgentCapabilityProfileId('max-capability-research')).toBe(true);
    expect(isAgentCapabilityProfileId('missing')).toBe(false);
    expect(getAgentCapabilityProfile('max-capability-research').id).toBe('max-capability-research');
  });

  it('expands max-capability-research into the protocol-level model, fallback, and memory contract', () => {
    const cfg = applyAgentCapabilityProfile(agent());
    const models = record(cfg.models);
    const memory = record(cfg.memory);
    const pinecone = record(memory.pinecone);
    const agentOptions = record(cfg.agentOptions);
    const providerConfig = record(agentOptions.providerConfig);
    const backupAgent = record(agentOptions.backupAgent);
    const proof = record(backupAgent.proof);

    expect(models).toMatchObject({
      conversation: 'claude-fable-5',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'gpt-5.4',
    });
    expect(cfg.maxTokens).toBe(200_000);
    expect(cfg.tokenBudget).toBe(10_000_000);
    expect(pinecone).toMatchObject({
      apiKeyEnv: 'PINECONE_API_KEY',
      projectId: 'nf9hzvy',
      expectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
      index: 'mw-mind',
      searchMode: 'entity',
      contextTopK: 40,
      senderTopK: 20,
      selfFactTopK: 20,
      topK: 80,
      rerank: false,
      rerankTopN: 30,
      allowedIndexes: ['mw-mind'],
    });
    expect(record(pinecone.knowledgeSearch)).toEqual({
      enabled: true,
      allowGlobalAgentSessions: true,
    });
    expect(record(record(pinecone.knowledgeProfiles)['mw-mind']).namespaces).toEqual([
      'local-docs',
      'onedrive',
      'whatsapp',
      'whatsapp-contacts',
      'whatsapp-facts',
      'whatsapp-chunks',
      'whatsapp-summaries',
    ]);
    expect(agentOptions).toMatchObject({
      sessionScope: 'per_chat',
      provider: 'claude-cli',
      autoCompactInputTokens: 400_000,
      fallbackProvider: 'opencode-cli',
      fallbackModel: 'minimax/MiniMax-M2.7-highspeed',
    });
    expect(record(agentOptions.fallbackProviderConfig)).toEqual({
      opencodeCommandMode: 'modern-run',
    });
    expect(providerConfig.fallbackModel).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(providerConfig.effort).toBe('high');
    expect(providerConfig.permissionMode).toBe('bypassPermissions');
    expect(backupAgent).toMatchObject({
      enabled: true,
      provider: 'opencode-cli',
      failureDomain: 'independent',
      contextWindow: 'same_or_smaller',
      maxDepth: 1,
    });
    expect(proof).toMatchObject({ differentProvider: true, differentCredential: true });
    expect(proof.evidence).toEqual(expect.any(String));
  });

  it('lets explicit instance fields override profile defaults without dropping sibling defaults', () => {
    const cfg = applyAgentCapabilityProfile(agent({
      models: { conversation: 'claude-opus-4-8' },
      maxTokens: 123_456,
      pineconeTopK: 33,
      memory: {
        pinecone: {
          topK: 12,
          allowedIndexes: ['custom-index'],
        },
      },
      agentOptions: {
        providerConfig: {
          effort: 'medium',
          fallbackModel: 'claude-sonnet-4-6',
        },
        fallbackModel: 'deepseek/deepseek-chat',
        fallbackProviderConfig: {
          opencodeCommandMode: 'legacy-prompt-json',
        },
      },
    }));
    const models = record(cfg.models);
    const pinecone = record(record(cfg.memory).pinecone);
    const agentOptions = record(cfg.agentOptions);
    const providerConfig = record(agentOptions.providerConfig);

    expect(models.conversation).toBe('claude-opus-4-8');
    expect(models.extraction).toBe('claude-sonnet-4-6');
    expect(cfg.maxTokens).toBe(123_456);
    expect(pinecone.topK).toBe(12);
    expect(cfg.pineconeTopK).toBe(33);
    expect(pinecone.allowedIndexes).toEqual(['custom-index']);
    expect(pinecone.projectId).toBe('nf9hzvy');
    expect(agentOptions.provider).toBe('claude-cli');
    expect(agentOptions.fallbackModel).toBe('deepseek/deepseek-chat');
    expect(record(agentOptions.fallbackProviderConfig).opencodeCommandMode).toBe('legacy-prompt-json');
    expect(providerConfig.effort).toBe('medium');
    expect(providerConfig.fallbackModel).toBe('claude-sonnet-4-6');
  });

  it('canonicalizes legacy memory aliases before merging defaults', () => {
    const cfg = applyAgentCapabilityProfile(agent({
      pineconeTopK: 33,
      pineconeAllowedIndexes: ['legacy-index'],
    }));
    const pinecone = record(record(cfg.memory).pinecone);

    expect(pinecone.topK).toBe(33);
    expect(pinecone.allowedIndexes).toEqual(['legacy-index']);
    expect(pinecone.projectId).toBe('nf9hzvy');
  });

  it('does not expand profiles for non-agent instances', () => {
    const raw = { name: 'chat', type: 'chat', agentProfile: 'max-capability-research' };
    expect(applyAgentCapabilityProfile(raw)).toBe(raw);
  });
});
