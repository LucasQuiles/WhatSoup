export const AGENT_CAPABILITY_PROFILE_IDS = ['max-capability-research'] as const;

export type AgentCapabilityProfileId = (typeof AGENT_CAPABILITY_PROFILE_IDS)[number];

type JsonObject = Record<string, unknown>;

export interface AgentCapabilityProfile {
  id: AgentCapabilityProfileId;
  description: string;
  defaults: JsonObject;
}

const MW_MIND_NAMESPACES = [
  'local-docs',
  'onedrive',
  'whatsapp',
  'whatsapp-contacts',
  'whatsapp-facts',
  'whatsapp-chunks',
  'whatsapp-summaries',
] as const;

const AGENT_CAPABILITY_PROFILES: Record<AgentCapabilityProfileId, AgentCapabilityProfile> = {
  'max-capability-research': {
    id: 'max-capability-research',
    description: 'High-capacity agent baseline with premium Claude hierarchy, OpenCode fallback, and broad mw-mind retrieval.',
    defaults: {
      models: {
        conversation: 'claude-fable-5',
        extraction: 'claude-sonnet-4-6',
        validation: 'claude-haiku-4-5',
        fallback: 'gpt-5.4',
      },
      maxTokens: 200_000,
      tokenBudget: 10_000_000,
      memory: {
        pinecone: {
          apiKeyEnv: 'PINECONE_API_KEY',
          projectId: 'nf9hzvy',
          expectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
          index: 'mw-mind',
          namespaces: {
            facts: 'whatsapp-facts',
            chunks: 'whatsapp-chunks',
            summaries: 'whatsapp-summaries',
            legacy: 'whatsapp',
            contacts: 'whatsapp-contacts',
            localDocs: 'local-docs',
            oneDrive: 'onedrive',
          },
          searchMode: 'entity',
          contextTopK: 40,
          senderTopK: 20,
          selfFactTopK: 20,
          topK: 80,
          rerank: false,
          rerankTopN: 30,
          allowedIndexes: ['mw-mind'],
          knowledgeSearch: {
            enabled: true,
            allowGlobalAgentSessions: true,
          },
          knowledgeProfiles: {
            'mw-mind': {
              namespace: '',
              namespaces: [...MW_MIND_NAMESPACES],
              searchMode: 'vector',
              rerank: false,
              rerankModel: '',
              topK: 80,
              rerankTopN: 30,
              description: 'High-capacity mw-mind retrieval profile for agent sessions.',
            },
          },
        },
      },
      agentOptions: {
        sessionScope: 'per_chat',
        provider: 'claude-cli',
        autoCompactInputTokens: 400_000,
        providerConfig: {
          fallbackModel: ['claude-opus-4-8', 'claude-sonnet-4-6'],
          effort: 'high',
          permissionMode: 'bypassPermissions',
        },
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'minimax/MiniMax-M2.7-highspeed',
        fallbackProviderConfig: {
          opencodeCommandMode: 'modern-run',
        },
        backupAgent: {
          enabled: true,
          provider: 'opencode-cli',
          failureDomain: 'independent',
          contextWindow: 'same_or_smaller',
          maxDepth: 1,
          proof: {
            differentProvider: true,
            differentCredential: true,
            evidence: 'OpenCode fallback uses a separately configured provider credential from the Claude CLI session; provider-status/keyring checks must prove the credential is present before treating fallback as operational.',
          },
        },
      },
    },
  },
};

const LEGACY_PROFILE_OVERRIDE_ALIASES: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'pineconeApiKeyEnv', to: 'memory.pinecone.apiKeyEnv' },
  { from: 'pineconeProjectId', to: 'memory.pinecone.projectId' },
  { from: 'pineconeExpectedHostSuffix', to: 'memory.pinecone.expectedHostSuffix' },
  { from: 'pineconeIndex', to: 'memory.pinecone.index' },
  { from: 'pineconeSearchMode', to: 'memory.pinecone.searchMode' },
  { from: 'pineconeRerank', to: 'memory.pinecone.rerank' },
  { from: 'pineconeRerankModel', to: 'memory.pinecone.rerankModel' },
  { from: 'pineconeTopK', to: 'memory.pinecone.topK' },
  { from: 'pineconeRerankTopN', to: 'memory.pinecone.rerankTopN' },
  { from: 'pineconeContextTopK', to: 'memory.pinecone.contextTopK' },
  { from: 'pineconeSenderTopK', to: 'memory.pinecone.senderTopK' },
  { from: 'pineconeSelfFactTopK', to: 'memory.pinecone.selfFactTopK' },
  { from: 'pineconeAllowedIndexes', to: 'memory.pinecone.allowedIndexes' },
  { from: 'pineconeKnowledgeSearch', to: 'memory.pinecone.knowledgeSearch' },
  { from: 'pineconeKnowledgeProfiles', to: 'memory.pinecone.knowledgeProfiles' },
  { from: 'pineconeEmbedUrl', to: 'memory.pinecone.embedUrl' },
  { from: 'pineconeNamespace', to: 'memory.pinecone.namespaces.legacy' },
  { from: 'pineconeFactsNamespace', to: 'memory.pinecone.namespaces.facts' },
  { from: 'pineconeChunksNamespace', to: 'memory.pinecone.namespaces.chunks' },
  { from: 'pineconeSummariesNamespace', to: 'memory.pinecone.namespaces.summaries' },
  { from: 'pineconeLegacyNamespace', to: 'memory.pinecone.namespaces.legacy' },
  { from: 'pineconeContactsNamespace', to: 'memory.pinecone.namespaces.contacts' },
  { from: 'pineconeLocalDocsNamespace', to: 'memory.pinecone.namespaces.localDocs' },
  { from: 'pineconeOneDriveNamespace', to: 'memory.pinecone.namespaces.oneDrive' },
];

export function isAgentCapabilityProfileId(value: unknown): value is AgentCapabilityProfileId {
  return (
    typeof value === 'string' &&
    (AGENT_CAPABILITY_PROFILE_IDS as readonly string[]).includes(value)
  );
}

export function getAgentCapabilityProfile(id: AgentCapabilityProfileId): AgentCapabilityProfile {
  return AGENT_CAPABILITY_PROFILES[id];
}

export function agentCapabilityProfileError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isAgentCapabilityProfileId(value)) {
    return `agentProfile must be one of: ${AGENT_CAPABILITY_PROFILE_IDS.join(', ')}`;
  }
  return null;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneJson(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJson(child)]),
    ) as T;
  }
  return value;
}

function mergeDefaults(defaults: JsonObject, explicit: JsonObject): JsonObject {
  const merged: JsonObject = cloneJson(defaults);
  for (const [key, explicitValue] of Object.entries(explicit)) {
    const defaultValue = merged[key];
    if (isPlainObject(defaultValue) && isPlainObject(explicitValue)) {
      merged[key] = mergeDefaults(defaultValue, explicitValue);
    } else {
      merged[key] = cloneJson(explicitValue);
    }
  }
  return merged;
}

function hasPath(root: JsonObject, path: string): boolean {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (!isPlainObject(current) || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function getPath(root: JsonObject, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (!isPlainObject(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function ensurePath(root: JsonObject, path: string[]): JsonObject {
  let current = root;
  for (const part of path) {
    if (!isPlainObject(current[part])) {
      current[part] = {};
    }
    current = current[part] as JsonObject;
  }
  return current;
}

function setPath(root: JsonObject, path: string, value: unknown): void {
  const parts = path.split('.');
  const key = parts.pop();
  if (!key) return;
  ensurePath(root, parts)[key] = cloneJson(value);
}

function canonicalizeLegacyProfileOverrides(raw: JsonObject): JsonObject {
  const explicit = cloneJson(raw);
  const legacyNamespaces = getPath(raw, 'pineconeNamespaces');
  if (isPlainObject(legacyNamespaces)) {
    for (const [namespaceKey, namespaceValue] of Object.entries(legacyNamespaces)) {
      const targetPath = `memory.pinecone.namespaces.${namespaceKey}`;
      if (!hasPath(raw, targetPath)) {
        setPath(explicit, targetPath, namespaceValue);
      }
    }
  }
  for (const mapping of LEGACY_PROFILE_OVERRIDE_ALIASES) {
    if (hasPath(raw, mapping.from) && !hasPath(raw, mapping.to)) {
      setPath(explicit, mapping.to, getPath(raw, mapping.from));
    }
  }
  return explicit;
}

export function applyAgentCapabilityProfile(raw: JsonObject): JsonObject {
  if (raw['type'] !== 'agent') return raw;
  const profileId = raw['agentProfile'];
  if (!isAgentCapabilityProfileId(profileId)) return raw;
  const profile = getAgentCapabilityProfile(profileId);
  const explicit = canonicalizeLegacyProfileOverrides(raw);
  return mergeDefaults(profile.defaults, explicit);
}
