export type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';

export interface Config {
  adminPhones: Set<string>;
  dbPath: string;
  authDir: string;
  mediaDir: string;
  botName: string;
  accessMode: AccessMode;
  healthPort: number;
  models: {
    conversation: string;
    extraction: string;
    validation: string;
    fallback: string;
  };

  // Conversation / LLM
  systemPrompt: string;
  maxTokens: number;
  tokenBudget: number;
  apiTimeoutMs: number;
  apiRetryDelayMs: number;

  // Conversation window
  conversationWindow: number;
  conversationWindowExtended: number;
  windowExtensionThresholdMs: number;

  // Rate limits
  rateLimitPerHour: number;
  rateLimitNoticeWindowMs: number;

  // Enrichment
  enrichmentIntervalMs: number;
  enrichmentBatchSize: number;
  enrichmentMinConfidence: number;
  enrichmentDedupThreshold: number;
  enrichmentMaxRetries: number;

  // Pinecone
  pineconeIndex: string;
  pineconeContextTopK: number;
  pineconeSenderTopK: number;
  pineconeSelfFactTopK: number;
  pineconeSearchMode: 'memory' | 'entity';
  pineconeRerank: boolean;
  pineconeTopK: number;
  pineconeRerankTopN: number;
}

export const config: Config = {
  adminPhones: new Set(
    (process.env.ADMIN_PHONES ?? '').split(',').map((p) => p.trim()).filter(Boolean),
  ),
  dbPath: process.env.WHATSOUP_DB_PATH ?? '/var/lib/whatsoup/data.db',
  authDir: process.env.WHATSOUP_AUTH_DIR ?? '/var/lib/whatsoup/auth',
  mediaDir: process.env.WHATSOUP_MEDIA_DIR ?? '/tmp/whatsoup-media',
  botName: process.env.WHATSOUP_BOT_NAME ?? 'WhatSoup',
  accessMode: (process.env.WHATSOUP_ACCESS_MODE ?? 'allowlist') as AccessMode,
  healthPort: parseInt(process.env.WHATSOUP_HEALTH_PORT ?? '9090', 10),
  models: {
    conversation: process.env.WHATSOUP_MODEL_CONVERSATION ?? 'claude-opus-4-5',
    extraction: process.env.WHATSOUP_MODEL_EXTRACTION ?? 'claude-haiku-4-5',
    validation: process.env.WHATSOUP_MODEL_VALIDATION ?? 'claude-haiku-4-5',
    fallback: process.env.WHATSOUP_MODEL_FALLBACK ?? 'claude-sonnet-4-5',
  },

  // Conversation / LLM
  systemPrompt: process.env.WHATSOUP_SYSTEM_PROMPT ?? 'You are WhatSoup, a helpful assistant.',
  maxTokens: parseInt(process.env.WHATSOUP_MAX_TOKENS ?? '750', 10),
  tokenBudget: parseInt(process.env.WHATSOUP_TOKEN_BUDGET ?? '100000', 10),
  apiTimeoutMs: 30_000,
  apiRetryDelayMs: 2_000,

  // Conversation window
  conversationWindow: 50,
  conversationWindowExtended: 100,
  windowExtensionThresholdMs: 10 * 60 * 1000,

  // Rate limits
  rateLimitPerHour: parseInt(process.env.WHATSOUP_RATE_LIMIT_PER_HOUR ?? '45', 10),
  rateLimitNoticeWindowMs: 60 * 60 * 1000,

  // Enrichment
  enrichmentIntervalMs: 60 * 1000,
  enrichmentBatchSize: 200,
  enrichmentMinConfidence: 0.7,
  enrichmentDedupThreshold: 0.95,
  enrichmentMaxRetries: 3,

  // Pinecone
  pineconeIndex: process.env.PINECONE_INDEX ?? 'whatsoup',
  pineconeContextTopK: 10,
  pineconeSenderTopK: 5,
  pineconeSelfFactTopK: 5,
  pineconeSearchMode: (process.env.WHATSOUP_PINECONE_SEARCH_MODE ?? 'memory') as 'memory' | 'entity',
  pineconeRerank: process.env.WHATSOUP_PINECONE_RERANK === 'true',
  pineconeTopK: parseInt(process.env.WHATSOUP_PINECONE_TOP_K ?? '20', 10),
  pineconeRerankTopN: parseInt(process.env.WHATSOUP_PINECONE_RERANK_TOP_N ?? '6', 10),
};
