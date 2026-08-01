import { isRecord } from './lib/type-guards.ts';

export interface MemoryMigrationOptions {
  removeLegacy?: boolean;
}

export interface MemoryMigrationResult {
  config: Record<string, unknown>;
  changed: boolean;
  moved: Array<{ from: string; to: string }>;
  removed: string[];
}

const LEGACY_FIELD_MAPPINGS: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'conversationWindow', to: 'memory.conversation.recent' },
  { from: 'conversationWindowExtended', to: 'memory.conversation.extended' },
  { from: 'windowExtensionThresholdMs', to: 'memory.conversation.extendedWithinMs' },
  { from: 'retentionDays', to: 'memory.retention.days' },
  { from: 'enrichmentIntervalMs', to: 'memory.enrichment.intervalMs' },
  { from: 'enrichmentBatchSize', to: 'memory.enrichment.batchSize' },
  { from: 'enrichmentMinConfidence', to: 'memory.enrichment.minConfidence' },
  { from: 'enrichmentDedupThreshold', to: 'memory.enrichment.dedupThreshold' },
  { from: 'enrichmentMaxRetries', to: 'memory.enrichment.maxRetries' },
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
  { from: 'recencyHalfLifeDays', to: 'memory.pinecone.recencyHalfLifeDays' },
  { from: 'maxAgeDays', to: 'memory.pinecone.maxAgeDays' },
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

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function hasPath(root: Record<string, unknown>, path: string): boolean {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function ensureRecordPath(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = root;
  for (const part of path) {
    if (!isRecord(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  return current;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const key = parts.pop();
  if (!key) return;
  const parent = ensureRecordPath(root, parts);
  parent[key] = cloneJson(value);
}

function deletePath(root: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  const key = parts.pop();
  if (!key) return false;
  let parent: unknown = root;
  for (const part of parts) {
    if (!isRecord(parent) || !isRecord(parent[part])) return false;
    parent = parent[part];
  }
  if (!isRecord(parent) || !(key in parent)) return false;
  delete parent[key];
  return true;
}

function migrateNamespaceObject(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  moved: Array<{ from: string; to: string }>,
): void {
  const legacyNamespaces = getPath(source, 'pineconeNamespaces');
  if (!isRecord(legacyNamespaces)) return;

  let didMove = false;
  for (const [namespaceKey, namespaceValue] of Object.entries(legacyNamespaces)) {
    const targetPath = `memory.pinecone.namespaces.${namespaceKey}`;
    if (hasPath(source, targetPath)) continue;
    setPath(target, targetPath, namespaceValue);
    didMove = true;
  }
  if (didMove) {
    moved.push({ from: 'pineconeNamespaces', to: 'memory.pinecone.namespaces' });
  }
}

export function migrateLegacyMemoryConfig(
  input: Record<string, unknown>,
  options: MemoryMigrationOptions = {},
): MemoryMigrationResult {
  const source = cloneJson(input);
  const migrated = cloneJson(input);
  const moved: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];

  migrateNamespaceObject(source, migrated, moved);

  for (const mapping of LEGACY_FIELD_MAPPINGS) {
    if (!hasPath(source, mapping.from)) continue;
    if (!hasPath(source, mapping.to)) {
      setPath(migrated, mapping.to, getPath(source, mapping.from));
      moved.push(mapping);
    }
  }

  if (options.removeLegacy) {
    for (const mapping of LEGACY_FIELD_MAPPINGS) {
      if (deletePath(migrated, mapping.from)) {
        removed.push(mapping.from);
      }
    }
    if (deletePath(migrated, 'pineconeNamespaces')) {
      removed.push('pineconeNamespaces');
    }
  }

  const changed =
    JSON.stringify(migrated) !== JSON.stringify(input) ||
    moved.length > 0 ||
    removed.length > 0;

  return { config: migrated, changed, moved, removed };
}
