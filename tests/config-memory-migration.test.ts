import { describe, expect, it } from 'vitest';
import { migrateLegacyMemoryConfig } from '../src/config-memory-migration.ts';

describe('migrateLegacyMemoryConfig', () => {
  it('projects legacy memory fields into memory.* and removes flat fields when requested', () => {
    const result = migrateLegacyMemoryConfig({
      name: 'mw-bot',
      pineconeApiKeyEnv: 'PINECONE_MWLAB_KEY',
      pineconeProjectId: 'nf9hzvy',
      pineconeExpectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
      pineconeIndex: 'mw-mind',
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeFactsNamespace: 'mw-facts',
      pineconeChunksNamespace: 'mw-chunks',
      pineconeSummariesNamespace: 'mw-summaries',
      conversationWindow: 60,
      enrichmentBatchSize: 300,
      retentionDays: 45,
    }, { removeLegacy: true });

    expect(result.config.memory).toEqual({
      conversation: { recent: 60 },
      retention: { days: 45 },
      enrichment: { batchSize: 300 },
      pinecone: {
        apiKeyEnv: 'PINECONE_MWLAB_KEY',
        projectId: 'nf9hzvy',
        expectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
        index: 'mw-mind',
        allowedIndexes: ['mw-mind'],
        namespaces: {
          facts: 'mw-facts',
          chunks: 'mw-chunks',
          summaries: 'mw-summaries',
        },
      },
    });
    expect(result.config).not.toHaveProperty('pineconeIndex');
    expect(result.config).not.toHaveProperty('pineconeAllowedIndexes');
    expect(result.removed).toContain('pineconeIndex');
    expect(result.changed).toBe(true);
  });

  it('keeps canonical memory values ahead of legacy aliases', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeIndex: 'legacy-index',
      pineconeFactsNamespace: 'legacy-facts',
      memory: {
        pinecone: {
          index: 'canonical-index',
          namespaces: { facts: 'canonical-facts' },
        },
      },
    }, { removeLegacy: false });

    expect((result.config.memory as any).pinecone.index).toBe('canonical-index');
    expect((result.config.memory as any).pinecone.namespaces.facts).toBe('canonical-facts');
    expect(result.config.pineconeIndex).toBe('legacy-index');
  });

  it('merges legacy pineconeNamespaces without clobbering canonical namespace keys', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: {
        facts: 'legacy-facts',
        chunks: 'legacy-chunks',
        summaries: 'legacy-summaries',
      },
      pineconeFactsNamespace: 'specific-facts',
      memory: {
        pinecone: {
          namespaces: { summaries: 'canonical-summaries' },
        },
      },
    }, { removeLegacy: true });

    expect((result.config.memory as any).pinecone.namespaces).toEqual({
      facts: 'specific-facts',
      chunks: 'legacy-chunks',
      summaries: 'canonical-summaries',
    });
    expect(result.config).not.toHaveProperty('pineconeNamespaces');
  });
});
