// Config helpers — build entries dynamically from real instance config
import { validatePhone } from '../../lib/validation'

export const CONFIG_EXCLUDE_KEYS = new Set(['name', 'type', 'paths', 'healthPort'])

export const CONFIG_PATH_KEYS = new Set(['cwd', 'instructionsPath', 'socketPath', 'configDir', 'dataDir', 'stateDir'])

export type ConfigEntryType = 'string' | 'number' | 'boolean' | 'path'

export type AgentOptionFieldType = 'string' | 'path' | 'boolean' | 'enum' | 'array'

export interface AgentOptionFieldDefinition {
  type: AgentOptionFieldType
  enum?: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getValueAtPath(source: unknown, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((value, segment) => (
    isRecord(value) ? value[segment] : undefined
  ), source)
}

export function setValueAtPath(target: Record<string, unknown>, keyPath: string, value: unknown): void {
  const segments = keyPath.split('.')
  let cursor = target
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (!isRecord(next)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]] = value
}

export function deleteValueAtPath(target: Record<string, unknown>, keyPath: string): void {
  const segments = keyPath.split('.')
  const parents: Record<string, unknown>[] = [target]
  let cursor = target

  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (!isRecord(next)) return
    parents.push(next)
    cursor = next
  }

  delete cursor[segments[segments.length - 1]]

  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const parent = parents[i]
    const childKey = segments[i]
    const child = parent[childKey]
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
      && leftKeys.every((key) => key in right && isEqualValue(left[key], right[key]))
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
}

export function buildConfigEntries(rawConfig: Record<string, unknown>): { key: string; value: string; type: ConfigEntryType }[] {
  const entries: { key: string; value: string; type: ConfigEntryType }[] = []

  for (const [key, value] of Object.entries(rawConfig)) {
    if (CONFIG_EXCLUDE_KEYS.has(key)) continue

    if (key === 'agentOptions' && isRecord(value)) {
      const remaining = cloneRecord(value)
      for (const [fieldKey, fieldDef] of Object.entries(AGENT_OPTION_FIELDS)) {
        const nestedPath = fieldKey.replace(/^agentOptions\./, '')
        const nestedValue = getValueAtPath(value, nestedPath)
        if (nestedValue === undefined) continue
        deleteValueAtPath(remaining, nestedPath)
        entries.push({
          key: fieldKey,
          value: formatConfigValue(nestedValue),
          type: getConfigEntryType(fieldKey, nestedValue, fieldDef.type),
        })
      }
      if (Object.keys(remaining).length > 0) {
        entries.push({
          key: 'agentOptions (other)',
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

export const TYPE_COLOR: Record<string, string> = {
  string: 'var(--color-m-pas)', number: 'var(--color-s-warn)',
  boolean: 'var(--color-m-agt)', path: 'var(--color-m-cht)',
}

export const ENUM_OPTIONS: Record<string, string[]> = {
  accessMode: ['self_only', 'allowlist', 'open_dm', 'groups_only'],
  toolUpdateMode: ['full', 'minimal'],
  model: ['', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
}

export const CUSTOM_ENUM_OPTION = '__custom__'
export const CUSTOMIZABLE_ENUM_KEYS = new Set(['model'])

export const FIELD_VALIDATORS: Record<string, (val: unknown) => string | null> = {
  adminPhones: v => Array.isArray(v) && v.length === 0
    ? 'At least one admin phone is required'
    : Array.isArray(v) && v.some((item) => typeof item !== 'string' || !validatePhone(item))
    ? 'Phone numbers must contain 10-15 digits'
    : null,
  maxTokens: v => typeof v === 'number' && v < 256 ? 'Min 256' : typeof v === 'number' && v > 200000 ? 'Max 200,000' : null,
  tokenBudget: v => typeof v === 'number' && v < 1000 ? 'Min 1,000' : typeof v === 'number' && v > 10000000 ? 'Max 10M' : null,
  rateLimitPerHour: v => typeof v === 'number' && v < 1 ? 'Min 1' : typeof v === 'number' && v > 10000 ? 'Max 10,000' : null,
}
