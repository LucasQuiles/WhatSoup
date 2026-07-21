import { asRecord } from './type-guards.ts';

/** Raw provider keys are never valid persisted instance configuration. */
export const PLAINTEXT_PROVIDER_KEY_FIELDS: readonly string[] = ['apiKey', 'openaiKey'];

const TRANSPORT_CONFIG_FIELDS = ['twilioConfig', 'signalConfig', 'imessageConfig'] as const;

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

function normalizedFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SAFE_TOP_LEVEL_FIELDS_WITH_SECRET_MARKERS = new Set([
  'maxtokens',
  'pineconeapikeyenv',
  'tokenbudget',
]);

function isPlaintextProviderKeyField(field: string): boolean {
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
    'token',
  ].some(marker => normalized.includes(marker));
}

function isSafeTransportScalar(field: string, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return false;
  }
  if (field !== 'publicBaseUrl' && field !== 'bluebubblesUrl') return true;
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function sanitizeTransportConfig(
  configField: TransportConfigField,
  value: Record<string, unknown>,
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
        if (nestedAllowlist.has(nestedField) && isSafeTransportScalar(nestedField, nestedValue)) {
          nested[nestedField] = nestedValue;
        } else {
          removed.push(`${configField}.${field}.${nestedField}`);
        }
      }
      clean[field] = nested;
    } else if (nestedAllowlist === null && isSafeTransportScalar(field, fieldValue)) {
      clean[field] = fieldValue;
    } else {
      removed.push(`${configField}.${field}`);
    }
  }

  return { clean, removed };
}

export function stripPlaintextProviderKeys(
  input: Record<string, unknown>,
): { clean: Record<string, unknown>; removed: string[] } {
  const clean = { ...input };
  const removed: string[] = [];
  for (const field of Object.keys(clean)) {
    if (!isPlaintextProviderKeyField(field)) continue;
    delete clean[field];
    removed.push(field);
  }
  for (const configField of TRANSPORT_CONFIG_FIELDS) {
    const value = clean[configField];
    if (value === undefined) continue;
    const configRecord = asRecord(value);
    if (!configRecord) {
      delete clean[configField];
      removed.push(configField);
      continue;
    }
    const sanitized = sanitizeTransportConfig(configField, configRecord);
    clean[configField] = sanitized.clean;
    removed.push(...sanitized.removed);
  }
  return { clean, removed };
}
