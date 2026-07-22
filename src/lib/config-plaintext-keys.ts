import { asRecord, setOwnRecordProperty } from './type-guards.ts';
import {
  isBluebubblesPasswordService,
  isBluebubblesPasswordServiceForAccount,
  isTrustedBluebubblesUrl,
} from './bluebubbles-config.ts';
import { isTwilioAuthTokenServiceForAccount } from './twilio-config.ts';
import { PROVIDER_API_KEY_SERVICES } from './provider-key-service.ts';

/** Raw provider keys are never valid persisted instance configuration. */
export const PLAINTEXT_PROVIDER_KEY_FIELDS: readonly string[] = ['apiKey', 'openaiKey'];

const TRANSPORT_CONFIG_FIELDS = ['twilioConfig', 'signalConfig', 'imessageConfig'] as const;

const PROVIDER_CONFIG_PATHS = [
  ['agentOptions', 'providerConfig'],
  ['chatOptions', 'openaiProviderConfig'],
  ['transcriptionOptions', 'openaiProviderConfig'],
] as const;

export const OPENAI_PROVIDER_CONFIG_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'baseUrl',
  'apiKeyService',
]);

export const AGENT_PROVIDER_CONFIG_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...OPENAI_PROVIDER_CONFIG_ALLOWED_FIELDS,
  'model',
  'maxTokens',
  'providerId',
  'executionProfile',
  'budget',
  'permissionMode',
  'rawSystemPrompt',
  'tools',
  'mcpConfig',
  'settingSources',
  'effort',
  'agents',
  'fallbackModel',
  'disableSlashCommands',
  'strictMcpConfig',
  'noSessionPersistence',
  'opencodeCommandMode',
]);

type ConfigPath = readonly string[];

function configPathKey(path: ConfigPath): string {
  return JSON.stringify(path);
}

function formatConfigPath(path: ConfigPath): string {
  return path.join('.');
}

function appendConfigPath(path: ConfigPath, segment: string): ConfigPath {
  return [...path, segment];
}

type TransportConfigField = typeof TRANSPORT_CONFIG_FIELDS[number];

const TRANSPORT_CONFIG_ALLOWLISTS: Readonly<Record<
  TransportConfigField,
  Readonly<Record<string, ReadonlySet<string> | null>>
>> = {
  twilioConfig: {
    account: null,
    accountSid: null,
    authTokenService: null,
    phoneNumber: null,
    messagingServiceSid: null,
    inboundMode: null,
    pollIntervalMs: null,
    rateLimit: new Set(['smsPerMinute']),
    webhook: new Set(['publicBaseUrl', 'listenPort', 'listenAddress']),
    voice: new Set(['enabled', 'voicemailGreeting', 'voicemailMaxLengthSec']),
  },
  signalConfig: {
    account: null,
    phoneNumber: null,
    socketPath: null,
    tcpHost: null,
    tcpPort: null,
    inboundMode: null,
    pollIntervalMs: null,
    rateLimit: new Set(['messagesPerMinute']),
  },
  imessageConfig: {
    account: null,
    backend: null,
    imsgSocketPath: null,
    bluebubblesUrl: null,
    bluebubblesPasswordService: null,
    sender: null,
    inboundMode: null,
    pollIntervalMs: null,
    rateLimit: new Set(['messagesPerMinute']),
  },
};

const OPAQUE_CONFIG_MAP_PATHS: ReadonlySet<string> = new Set([
  ['agentOptions', 'providerConfig', 'agents'],
  ['capabilityGrantGroups'],
  ['chatAliases'],
  ['memory', 'pinecone', 'knowledgeProfiles'],
  ['memory', 'pinecone', 'namespaces'],
  ['pineconeKnowledgeProfiles'],
  ['pineconeNamespaces'],
  ['profiles'],
].map(configPathKey));

type MemoryProjection =
  | null
  | 'env-name'
  | 'safe-url'
  | 'string-map'
  | 'profile-map'
  | MemoryProjectionObject;

interface MemoryProjectionObject {
  readonly [field: string]: MemoryProjection;
}

const KNOWLEDGE_PROFILE_PROJECTION: Readonly<Record<string, MemoryProjection>> = {
  namespace: null,
  namespaces: null,
  searchMode: null,
  rerank: null,
  rerankModel: null,
  topK: null,
  rerankTopN: null,
  description: null,
  embedUrl: 'safe-url',
};

const MEMORY_CONFIG_PROJECTION: Readonly<Record<string, MemoryProjection>> = {
  admin_jid: null,
  vaultPath: null,
  observation_confidence_min: null,
  sweep: {
    bead_propose_min: null,
    bead_update_min: null,
    lookback_hours: null,
    review_by_days: null,
    overdue_proposal_alert_threshold: null,
  },
  watch_ttl: {
    default_hours: null,
    max_hours: null,
  },
  file_watch: {
    allowed_roots: null,
  },
  conversation: {
    recent: null,
    extended: null,
    extendedWithinMs: null,
  },
  retention: {
    days: null,
  },
  consolidation: {
    enabled: null,
    intervalHours: null,
    lookbackDays: null,
    dryRun: null,
  },
  enrichment: {
    intervalMs: null,
    batchSize: null,
    minConfidence: null,
    dedupThreshold: null,
    maxRetries: null,
  },
  pinecone: {
    apiKeyEnv: 'env-name',
    projectId: null,
    expectedHostSuffix: null,
    index: null,
    namespaces: 'string-map',
    contextTopK: null,
    senderTopK: null,
    selfFactTopK: null,
    searchMode: null,
    rerank: null,
    rerankModel: null,
    topK: null,
    rerankTopN: null,
    allowedIndexes: null,
    embedUrl: 'safe-url',
    recencyHalfLifeDays: null,
    maxAgeDays: null,
    knowledgeSearch: {
      enabled: null,
      allowGlobalAgentSessions: null,
    },
    knowledgeProfiles: 'profile-map',
  },
};

function normalizedFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ENVIRONMENT_VARIABLE_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

function isSafeEnvironmentVariableName(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_VARIABLE_NAME_RE.test(value);
}

function isPineconeApiKeyEnvPath(path: ConfigPath): boolean {
  return configPathKey(path) === configPathKey(['memory', 'pinecone', 'apiKeyEnv'])
    || configPathKey(path) === configPathKey(['pineconeApiKeyEnv']);
}

function isPineconeEmbedUrlPath(path: ConfigPath): boolean {
  return configPathKey(path) === configPathKey(['memory', 'pinecone', 'embedUrl'])
    || configPathKey(path) === configPathKey(['pineconeEmbedUrl'])
    || (
      path.length === 5
      && path[0] === 'memory'
      && path[1] === 'pinecone'
      && path[2] === 'knowledgeProfiles'
      && path[4] === 'embedUrl'
    )
    || (
      path.length === 3
      && path[0] === 'pineconeKnowledgeProfiles'
      && path[2] === 'embedUrl'
    );
}

function isUnsafeMemoryCredentialReference(path: ConfigPath, value: unknown): boolean {
  if (isPineconeApiKeyEnvPath(path)) return !isSafeEnvironmentVariableName(value);
  if (isPineconeEmbedUrlPath(path)) return !isSafeProviderBaseUrl(value);
  return false;
}

const SAFE_TOP_LEVEL_FIELDS_WITH_SECRET_MARKERS = new Set([
  'maxtokens',
  'costpermilliontokens',
  'tokenbudget',
  'tokensperminute',
  'autocompactinputtokens',
]);

export function isPlaintextProviderKeyField(field: string): boolean {
  const normalized = normalizedFieldName(field);
  if (SAFE_TOP_LEVEL_FIELDS_WITH_SECRET_MARKERS.has(normalized)) return false;
  return [
    'apikey',
    'openaikey',
    'authtoken',
    'bluebubblespassword',
    'password',
    'secret',
    'credential',
    'authorization',
    'cookie',
    'token',
  ].some(marker => normalized.includes(marker));
}

function isCredentialFieldAtPath(field: string, containerPath: ConfigPath): boolean {
  const fieldPath = appendConfigPath(containerPath, field);
  if (isPineconeApiKeyEnvPath(fieldPath)) return false;
  return !OPAQUE_CONFIG_MAP_PATHS.has(configPathKey(containerPath))
    && isPlaintextProviderKeyField(field);
}

export function findPlaintextProviderSecretField(
  value: Record<string, unknown>,
  path: string,
  allowApiKeyService = true,
): string | null {
  return findPlaintextProviderSecretFieldAtPath(
    value,
    path === '' ? [] : path.split('.'),
    allowApiKeyService,
  );
}

function findPlaintextProviderSecretFieldAtPath(
  value: Record<string, unknown>,
  path: ConfigPath,
  allowApiKeyService: boolean,
): string | null {
  for (const [field, fieldValue] of Object.entries(value)) {
    const fieldPath = appendConfigPath(path, field);
    if (
      !(allowApiKeyService && field === 'apiKeyService')
      && isCredentialFieldAtPath(field, path)
    ) {
      return formatConfigPath(fieldPath);
    }
    if (Array.isArray(fieldValue)) {
      for (let index = 0; index < fieldValue.length; index++) {
        const nested = asRecord(fieldValue[index]);
        if (!nested) continue;
        const found = findPlaintextProviderSecretFieldAtPath(
          nested,
          appendConfigPath(fieldPath, String(index)),
          false,
        );
        if (found) return found;
      }
      continue;
    }
    const nested = asRecord(fieldValue);
    if (!nested) continue;
    const found = findPlaintextProviderSecretFieldAtPath(nested, fieldPath, false);
    if (found) return found;
  }
  return null;
}

const ALLOWED_INSTANCE_SECRET_SELECTOR_PATHS: ReadonlySet<string> = new Set([
  ['agentOptions', 'providerConfig', 'apiKeyService'],
  ['chatOptions', 'openaiProviderConfig', 'apiKeyService'],
  ['transcriptionOptions', 'openaiProviderConfig', 'apiKeyService'],
  ['twilioConfig', 'authTokenService'],
  ['imessageConfig', 'bluebubblesPasswordService'],
  ['memory', 'pinecone', 'apiKeyEnv'],
].map(configPathKey));

/**
 * Find credential-shaped fields anywhere in a raw instance config while
 * preserving the small set of configuration selectors that name a keyring or
 * environment variable. Selector values are validated by their owning config
 * validators; raw credentials fail closed before auth-only bootstrap can
 * short-circuit type-specific validation.
 */
export function findPlaintextInstanceSecretField(
  value: Record<string, unknown>,
  path = '',
): string | null {
  return findPlaintextInstanceSecretFieldAtPath(
    value,
    path === '' ? [] : path.split('.'),
  );
}

function findPlaintextInstanceSecretFieldAtPath(
  value: Record<string, unknown>,
  path: ConfigPath,
): string | null {
  for (const [field, fieldValue] of Object.entries(value)) {
    const fieldPath = appendConfigPath(path, field);
    if (isUnsafeMemoryCredentialReference(fieldPath, fieldValue)) {
      return formatConfigPath(fieldPath);
    }
    if (
      isCredentialFieldAtPath(field, path)
      && !ALLOWED_INSTANCE_SECRET_SELECTOR_PATHS.has(configPathKey(fieldPath))
    ) {
      return formatConfigPath(fieldPath);
    }
    if (Array.isArray(fieldValue)) {
      for (let index = 0; index < fieldValue.length; index++) {
        const nested = asRecord(fieldValue[index]);
        if (!nested) continue;
        const found = findPlaintextInstanceSecretFieldAtPath(
          nested,
          appendConfigPath(fieldPath, String(index)),
        );
        if (found) return found;
      }
      continue;
    }
    const nested = asRecord(fieldValue);
    if (!nested) continue;
    const found = findPlaintextInstanceSecretFieldAtPath(nested, fieldPath);
    if (found) return found;
  }
  return null;
}

function sanitizeProviderConfigSecrets(
  value: Record<string, unknown>,
  path: ConfigPath,
  removed: string[],
  allowedFields: ReadonlySet<string> | null,
  allowApiKeyService: boolean,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    const fieldPath = appendConfigPath(path, field);
    if (allowedFields !== null && !allowedFields.has(field)) {
      removed.push(formatConfigPath(fieldPath));
      continue;
    }
    if (
      !(allowApiKeyService && field === 'apiKeyService')
      && isCredentialFieldAtPath(field, path)
    ) {
      removed.push(formatConfigPath(fieldPath));
      continue;
    }
    if (field === 'baseUrl' && !isSafeProviderBaseUrl(fieldValue)) {
      removed.push(formatConfigPath(fieldPath));
      continue;
    }
    if (Array.isArray(fieldValue)) {
      setOwnRecordProperty(clean, field, fieldValue.map((entry, index) => {
        const nested = asRecord(entry);
        return nested
          ? sanitizeProviderConfigSecrets(
            nested,
            appendConfigPath(fieldPath, String(index)),
            removed,
            null,
            false,
          )
          : entry;
      }));
      continue;
    }
    const nested = asRecord(fieldValue);
    setOwnRecordProperty(
      clean,
      field,
      nested
        ? sanitizeProviderConfigSecrets(nested, fieldPath, removed, null, false)
        : fieldValue,
    );
  }
  if (
    Object.hasOwn(clean, 'apiKeyService') &&
    (
      typeof clean.apiKeyService !== 'string' ||
      !PROVIDER_API_KEY_SERVICES.has(clean.apiKeyService) ||
      !Object.hasOwn(clean, 'baseUrl')
    )
  ) {
    delete clean.apiKeyService;
    removed.push(formatConfigPath(appendConfigPath(path, 'apiKeyService')));
  }
  return clean;
}

function sanitizeKnownProviderConfigs(
  clean: Record<string, unknown>,
  removed: string[],
): void {
  for (const [parentField, configField] of PROVIDER_CONFIG_PATHS) {
    const parent = asRecord(clean[parentField]);
    if (!parent) continue;
    const providerConfig = asRecord(parent[configField]);
    if (!providerConfig) {
      if (Object.hasOwn(parent, configField)) {
        const parentClean = { ...parent };
        delete parentClean[configField];
        clean[parentField] = parentClean;
        removed.push(`${parentField}.${configField}`);
      }
      continue;
    }
    const allowedFields = parentField === 'agentOptions'
      ? AGENT_PROVIDER_CONFIG_ALLOWED_FIELDS
      : OPENAI_PROVIDER_CONFIG_ALLOWED_FIELDS;
    clean[parentField] = {
      ...parent,
      [configField]: sanitizeProviderConfigSecrets(
        providerConfig,
        [parentField, configField],
        removed,
        allowedFields,
        true,
      ),
    };
  }
}

function sanitizeMemoryProjection(
  value: unknown,
  projection: MemoryProjection,
  path: string,
  removed: string[],
): unknown {
  if (projection === null) return value;

  if (projection === 'env-name') {
    if (isSafeEnvironmentVariableName(value)) return value;
    removed.push(path);
    return undefined;
  }

  if (projection === 'safe-url') {
    if (isSafeProviderBaseUrl(value)) return value;
    removed.push(path);
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    removed.push(path);
    return undefined;
  }

  if (projection === 'string-map') {
    const clean: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(record)) {
      const fieldPath = `${path}.${field}`;
      if (typeof fieldValue === 'string') setOwnRecordProperty(clean, field, fieldValue);
      else removed.push(fieldPath);
    }
    return clean;
  }

  if (projection === 'profile-map') {
    const clean: Record<string, unknown> = {};
    for (const [profileName, profileValue] of Object.entries(record)) {
      const profilePath = `${path}.${profileName}`;
      const sanitized = sanitizeMemoryProjection(
        profileValue,
        KNOWLEDGE_PROFILE_PROJECTION,
        profilePath,
        removed,
      );
      if (sanitized !== undefined) setOwnRecordProperty(clean, profileName, sanitized);
    }
    return clean;
  }

  const clean: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(record)) {
    const fieldPath = `${path}.${field}`;
    if (!Object.hasOwn(projection, field)) {
      removed.push(fieldPath);
      continue;
    }
    const sanitized = sanitizeMemoryProjection(
      fieldValue,
      projection[field],
      fieldPath,
      removed,
    );
    if (sanitized !== undefined) setOwnRecordProperty(clean, field, sanitized);
  }
  return clean;
}

function sanitizeKnownMemoryConfig(
  clean: Record<string, unknown>,
  removed: string[],
): void {
  if (!Object.hasOwn(clean, 'memory')) return;
  const sanitized = sanitizeMemoryProjection(
    clean.memory,
    MEMORY_CONFIG_PROJECTION,
    'memory',
    removed,
  );
  if (sanitized === undefined) delete clean.memory;
  else clean.memory = sanitized;
}

function sanitizeOpaqueInstanceValue(
  value: unknown,
  path: ConfigPath,
  removed: string[],
): unknown {
  const pathKey = configPathKey(path);
  if (pathKey === configPathKey(['pineconeNamespaces'])) {
    return sanitizeMemoryProjection(value, 'string-map', formatConfigPath(path), removed);
  }
  if (pathKey === configPathKey(['pineconeKnowledgeProfiles'])) {
    return sanitizeMemoryProjection(value, 'profile-map', formatConfigPath(path), removed);
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeOpaqueInstanceValue(
      entry,
      appendConfigPath(path, String(index)),
      removed,
    ));
  }

  const record = asRecord(value);
  if (!record) return value;

  const clean: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(record)) {
    const fieldPath = appendConfigPath(path, field);
    if (isUnsafeMemoryCredentialReference(fieldPath, fieldValue)) {
      removed.push(formatConfigPath(fieldPath));
      continue;
    }
    if (
      isCredentialFieldAtPath(field, path)
      && !ALLOWED_INSTANCE_SECRET_SELECTOR_PATHS.has(configPathKey(fieldPath))
    ) {
      removed.push(formatConfigPath(fieldPath));
      continue;
    }
    setOwnRecordProperty(
      clean,
      field,
      sanitizeOpaqueInstanceValue(fieldValue, fieldPath, removed),
    );
  }
  return clean;
}

export function hasDisallowedTransportUrlComponents(url: URL): boolean {
  return url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '';
}

function isSafeProviderBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !hasDisallowedTransportUrlComponents(parsed)
    );
  } catch {
    return false;
  }
}

function isSafeTransportScalar(configField: TransportConfigField, field: string, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return false;
  }
  if (configField === 'imessageConfig' && field === 'bluebubblesPasswordService') {
    return typeof value === 'string' && isBluebubblesPasswordService(value);
  }
  if (configField === 'imessageConfig' && field === 'bluebubblesUrl') {
    return typeof value === 'string' && isTrustedBluebubblesUrl(value);
  }
  if (field !== 'publicBaseUrl' && field !== 'bluebubblesUrl') return true;
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    const protocolAllowed = field === 'publicBaseUrl'
      ? parsed.protocol === 'https:'
      : parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return protocolAllowed && !hasDisallowedTransportUrlComponents(parsed);
  } catch {
    return false;
  }
}

function sanitizeTransportConfig(
  configField: TransportConfigField,
  value: Record<string, unknown>,
  lineName?: string,
): { clean: Record<string, unknown>; removed: string[] } {
  const allowlist = TRANSPORT_CONFIG_ALLOWLISTS[configField];
  const clean: Record<string, unknown> = {};
  const removed: string[] = [];

  for (const [field, fieldValue] of Object.entries(value)) {
    // New transport fields must be explicitly classified before persistence.
    if (!Object.hasOwn(allowlist, field)) {
      removed.push(`${configField}.${field}`);
      continue;
    }
    const nestedAllowlist = allowlist[field];
    const nestedRecord = asRecord(fieldValue);
    if (nestedAllowlist !== null && nestedRecord) {
      const nested: Record<string, unknown> = {};
      for (const [nestedField, nestedValue] of Object.entries(nestedRecord)) {
        if (nestedAllowlist.has(nestedField) && isSafeTransportScalar(configField, nestedField, nestedValue)) {
          nested[nestedField] = nestedValue;
        } else {
          removed.push(`${configField}.${field}.${nestedField}`);
        }
      }
      clean[field] = nested;
    } else if (nestedAllowlist === null && isSafeTransportScalar(configField, field, fieldValue)) {
      clean[field] = fieldValue;
    } else {
      removed.push(`${configField}.${field}`);
    }
  }

  if (configField === 'twilioConfig') {
    const service = clean.authTokenService;
    if (
      Object.hasOwn(clean, 'authTokenService') &&
      (
        typeof service !== 'string' ||
        lineName === undefined ||
        !isTwilioAuthTokenServiceForAccount(service, lineName)
      )
    ) {
      delete clean.authTokenService;
      removed.push('twilioConfig.authTokenService');
    }
  }

  if (configField === 'imessageConfig') {
    const account = lineName ?? clean.account;
    const service = clean.bluebubblesPasswordService;
    if (
      typeof service === 'string'
      && (typeof account !== 'string' || !isBluebubblesPasswordServiceForAccount(service, account))
    ) {
      delete clean.bluebubblesPasswordService;
      removed.push('imessageConfig.bluebubblesPasswordService');
    }

    const backend = clean.backend;
    const removeBackendField = (field: string): void => {
      if (!Object.hasOwn(clean, field)) return;
      delete clean[field];
      removed.push(`imessageConfig.${field}`);
    };
    if (backend === 'imsg') {
      removeBackendField('bluebubblesUrl');
      removeBackendField('bluebubblesPasswordService');
    } else if (backend === 'bluebubbles') {
      removeBackendField('imsgSocketPath');
    } else if (backend !== undefined) {
      removeBackendField('imsgSocketPath');
      removeBackendField('bluebubblesUrl');
      removeBackendField('bluebubblesPasswordService');
    }
  }

  return { clean, removed };
}

export function stripPlaintextProviderKeys(
  input: Record<string, unknown>,
  trustedLineName?: string,
): { clean: Record<string, unknown>; removed: string[] } {
  const clean = { ...input };
  const removed: string[] = [];
  for (const field of Object.keys(clean)) {
    if (!isCredentialFieldAtPath(field, [])) continue;
    delete clean[field];
    removed.push(field);
  }
  sanitizeKnownProviderConfigs(clean, removed);
  sanitizeKnownMemoryConfig(clean, removed);
  for (const configField of TRANSPORT_CONFIG_FIELDS) {
    const value = clean[configField];
    if (value === undefined) continue;
    const configRecord = asRecord(value);
    if (!configRecord) {
      delete clean[configField];
      removed.push(configField);
      continue;
    }
    const lineName = trustedLineName ?? (typeof clean.name === 'string' ? clean.name : undefined);
    const sanitized = sanitizeTransportConfig(configField, configRecord, lineName);
    clean[configField] = sanitized.clean;
    removed.push(...sanitized.removed);
  }
  return {
    clean: sanitizeOpaqueInstanceValue(clean, [], removed) as Record<string, unknown>,
    removed,
  };
}
