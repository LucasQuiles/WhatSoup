// Config helpers — build entries dynamically from real instance config
import { isTransportKind, TRANSPORT_MAP } from '../../lib/transport-meta'
import { isRecord } from '../../lib/type-guards'
import { ACCESS_MODE_VALUES } from '../../lib/access-modes'
import { CHAT_API_KEY_SERVICE_OPTIONS, PROVIDERS } from '../../lib/providers'

/** Provider ids sourced from the single console catalog — never a second hardcoded list. */
const PROVIDER_IDS = PROVIDERS.map((p) => p.id)

export { isRecord }

export const CONFIG_EXCLUDE_KEYS = new Set(['name', 'type', 'transport', 'paths', 'healthPort'])

export const CONFIG_PATH_KEYS = new Set(['cwd', 'instructionsPath', 'socketPath', 'configDir', 'dataDir', 'stateDir'])

export type ConfigEntryType = 'string' | 'number' | 'boolean' | 'path'

export type AgentOptionFieldType = 'string' | 'path' | 'boolean' | 'enum' | 'array'

export interface AgentOptionFieldDefinition {
  type: AgentOptionFieldType
  enum?: string[]
}

const UNSAFE_CONFIG_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export function isSafeConfigPath(keyPath: string): boolean {
  const segments = keyPath.split('.')
  return segments.length > 0
    && segments.every(segment => segment.length > 0 && !UNSAFE_CONFIG_PATH_SEGMENTS.has(segment))
}

export function getValueAtPath(source: unknown, keyPath: string): unknown {
  if (!isSafeConfigPath(keyPath)) return undefined
  return keyPath.split('.').reduce<unknown>((value, segment) => (
    isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined
  ), source)
}

export function setValueAtPath(target: Record<string, unknown>, keyPath: string, value: unknown): void {
  if (!isSafeConfigPath(keyPath)) return
  const segments = keyPath.split('.')
  let cursor = target
  for (const segment of segments.slice(0, -1)) {
    const next = Object.hasOwn(cursor, segment) ? cursor[segment] : undefined
    if (!isRecord(next)) {
      Object.defineProperty(cursor, segment, {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  Object.defineProperty(cursor, segments[segments.length - 1], {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

export function deleteValueAtPath(target: Record<string, unknown>, keyPath: string): void {
  if (!isSafeConfigPath(keyPath)) return
  const segments = keyPath.split('.')
  const parents: Record<string, unknown>[] = [target]
  let cursor = target

  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(cursor, segment)) return
    const next = cursor[segment]
    if (!isRecord(next)) return
    parents.push(next)
    cursor = next
  }

  delete cursor[segments[segments.length - 1]]

  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const parent = parents[i]
    const childKey = segments[i]
    const child = Object.hasOwn(parent, childKey) ? parent[childKey] : undefined
    if (isRecord(child) && Object.keys(child).length === 0) {
      delete parent[childKey]
      continue
    }
    break
  }
}

export function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

export function isEqualValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => isEqualValue(item, right[index]))
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && isEqualValue(left[key], right[key]))
  }

  return false
}

export function formatConfigValue(value: unknown): string {
  const rawValue = typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : String(value)
  return rawValue.length > 80 ? `${rawValue.slice(0, 77)}...` : rawValue
}

export function getConfigEntryType(key: string, value: unknown, explicitType?: AgentOptionFieldType): ConfigEntryType {
  if (explicitType === 'boolean' || typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (explicitType === 'path' || CONFIG_PATH_KEYS.has(key)) return 'path'
  return 'string'
}

export const AGENT_OPTION_FIELDS: Record<string, AgentOptionFieldDefinition> = {
  'agentOptions.sessionScope': { type: 'enum', enum: ['single', 'shared', 'per_chat'] },
  'agentOptions.cwd': { type: 'path' },
  'agentOptions.instructionsPath': { type: 'path' },
  'agentOptions.sandboxPerChat': { type: 'boolean' },
  'agentOptions.pluginDirs': { type: 'array' },
  'agentOptions.mcp.inheritUserConfig': { type: 'boolean' },
  // Fallback provider/model — typed so they render as editable rows in
  // ConfigEditDialog instead of falling into the read-only "agentOptions (other)"
  // JSON blob. Saved via the existing PATCH /api/lines/:name/config path.
  'agentOptions.fallbackProvider': { type: 'enum', enum: PROVIDER_IDS },
  'agentOptions.fallbackModel': { type: 'string' },
}

export const CHAT_OPTION_FIELDS: Record<string, AgentOptionFieldDefinition> = {
  'chatOptions.openaiProviderConfig.baseUrl': { type: 'string' },
  'chatOptions.openaiProviderConfig.apiKeyService': {
    type: 'enum',
    enum: ['', ...CHAT_API_KEY_SERVICE_OPTIONS],
  },
}

function formatDeclaredNestedEntries(
  value: Record<string, unknown>,
  fields: Record<string, AgentOptionFieldDefinition>,
  rootKey: string,
): {
  entries: { key: string; value: string; type: ConfigEntryType }[]
  remaining: Record<string, unknown>
} {
  const entries: { key: string; value: string; type: ConfigEntryType }[] = []
  const remaining = cloneRecord(value)

  for (const [fieldKey, fieldDef] of Object.entries(fields)) {
    const nestedPath = fieldKey.replace(new RegExp(`^${rootKey}\\.`), '')
    const nestedValue = getValueAtPath(value, nestedPath)
    if (nestedValue === undefined) continue
    deleteValueAtPath(remaining, nestedPath)
    entries.push({
      key: fieldKey,
      value: formatConfigValue(nestedValue),
      type: getConfigEntryType(fieldKey, nestedValue, fieldDef.type),
    })
  }

  return { entries, remaining }
}

export function buildConfigEntries(rawConfig: Record<string, unknown>): { key: string; value: string; type: ConfigEntryType }[] {
  const entries: { key: string; value: string; type: ConfigEntryType }[] = []

  for (const [key, value] of Object.entries(rawConfig)) {
    if (CONFIG_EXCLUDE_KEYS.has(key)) continue
    if (!isSafeConfigPath(key)) continue

    if (key === 'agentOptions' && isRecord(value)) {
      const { entries: nestedEntries, remaining } = formatDeclaredNestedEntries(value, AGENT_OPTION_FIELDS, 'agentOptions')
      entries.push(...nestedEntries)
      if (Object.keys(remaining).length > 0) {
        entries.push({
          key: 'agentOptions (other)',
          value: formatConfigValue(remaining),
          type: 'string',
        })
      }
      continue
    }

    if (key === 'chatOptions' && rawConfig.type === 'chat' && isRecord(value)) {
      const { entries: nestedEntries, remaining } = formatDeclaredNestedEntries(value, CHAT_OPTION_FIELDS, 'chatOptions')
      entries.push(...nestedEntries)
      if (Object.keys(remaining).length > 0) {
        entries.push({
          key: 'chatOptions (other)',
          value: formatConfigValue(remaining),
          type: 'string',
        })
      }
      continue
    }

    entries.push({
      key,
      value: formatConfigValue(value),
      type: getConfigEntryType(key, value),
    })
  }

  return entries
}

export { CONFIG_VALUE_TYPE_COLOR as TYPE_COLOR } from '../../lib/color-semantics'

export const ENUM_OPTIONS: Record<string, string[]> = {
  accessMode: [...ACCESS_MODE_VALUES],
  toolUpdateMode: ['full', 'minimal'],
  model: ['', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'chatOptions.openaiProviderConfig.apiKeyService': ['', ...CHAT_API_KEY_SERVICE_OPTIONS],
}

export const CUSTOM_ENUM_OPTION = '__custom__'
export const CUSTOMIZABLE_ENUM_KEYS = new Set(['model'])

export function validateAdminPhones(value: unknown, transport?: string | null): string | null {
  if (!Array.isArray(value)) return null
  const kind = isTransportKind(transport) ? transport : 'baileys'
  if (value.length === 0) {
    return kind === 'baileys' || kind === 'twilio'
      ? 'At least one admin phone is required'
      : 'At least one admin identity is required'
  }
  if (value.some(item => typeof item !== 'string' || !TRANSPORT_MAP[kind].validateAdminId(item))) {
    if (kind === 'baileys' || kind === 'twilio') return 'Phone numbers must contain 10-15 digits'
    if (kind === 'signal') return 'Signal admin IDs must be an E.164 phone number or UUID'
    return 'iMessage admin IDs must be an E.164 phone number or lowercase AppleID email'
  }
  return null
}

export const FIELD_VALIDATORS: Record<string, (val: unknown) => string | null> = {
  adminPhones: v => validateAdminPhones(v, 'baileys'),
  maxTokens: v => typeof v === 'number' && v < 256 ? 'Min 256' : typeof v === 'number' && v > 200000 ? 'Max 200,000' : null,
  tokenBudget: v => typeof v === 'number' && v < 1000 ? 'Min 1,000' : typeof v === 'number' && v > 10000000 ? 'Max 10M' : null,
  rateLimitPerHour: v => typeof v === 'number' && v < 1 ? 'Min 1' : typeof v === 'number' && v > 10000 ? 'Max 10,000' : null,
  'chatOptions.openaiProviderConfig.baseUrl': v => {
    if (typeof v !== 'string') return 'Enter a valid http:// or https:// URL'
    if (v.trim() === '') return null
    try {
      const parsed = new URL(v)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? null
        : 'Enter a valid http:// or https:// URL'
    } catch {
      return 'Enter a valid http:// or https:// URL'
    }
  },
  'chatOptions.openaiProviderConfig.apiKeyService': v => (
    typeof v === 'string' && (v === '' || CHAT_API_KEY_SERVICE_OPTIONS.includes(v))
      ? null
      : 'Choose a provider keyring service'
  ),
}
