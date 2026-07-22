/**
 * ConfigEditDialog — migrated to Modal primitive (B3 wave-2).
 *
 * Migration:
 *   - Removes ad-hoc backdrop div, stopPropagation, and hand-wired aria attrs.
 *   - dismissable=false: backdrop click was silently destroying the whole patch.
 *     modal.md: explicit Save/Cancel verbs exist — protective default applied.
 *   - NEW required `open` prop + LineDetail always-mounts while line.config
 *     (C-B3W2-1): useDismissable restores focus only on the open→false transition,
 *     never on unmount; always-mounted ensures focus-restoration works correctly.
 *   - Restart-warning strip placed as a direct shell child between ModalHeader and
 *     ModalBody to stay non-scrolling (C-B3W2-6 spec-tension item).
 *   - GAINS: stacking-aware Escape (previously had NONE), focus trap, focus
 *     restoration.
 *   - Width: --panel-config-edit 560px → size="md" 560px (exact match, zero delta).
 *   - Token deletions: --panel-config-edit and --modal-max-h-sm retired (last
 *     consumers gone; verified zero remaining references).
 *   - Title typography normalises to soup-modal-title; X import removed.
 */
import React, { useState, useCallback, useEffect, useId } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Save } from 'lucide-react'
import TagInput from '../TagInput'
import { isTransportKind, TRANSPORT_MAP } from '../../lib/transport-meta'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import {
  CheckboxField,
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  NumberInput,
  SelectInput,
  TextArea,
  TextInput,
} from '../primitives'
import { Button } from '../primitives/Button'
import {
  CONFIG_EXCLUDE_KEYS,
  AGENT_OPTION_FIELDS,
  CHAT_OPTION_FIELDS,
  ENUM_OPTIONS,
  CUSTOM_ENUM_OPTION,
  CUSTOMIZABLE_ENUM_KEYS,
  FIELD_VALIDATORS,
  validateAdminPhones,
  isRecord,
  isSafeConfigPath,
  getValueAtPath,
  setValueAtPath,
  deleteValueAtPath,
  cloneRecord,
  isEqualValue,
} from './config-helpers'

function fieldIdSegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'field'
}

const CHAT_OPENAI_BASE_URL_KEY = 'chatOptions.openaiProviderConfig.baseUrl'
const CHAT_OPENAI_API_KEY_SERVICE_KEY = 'chatOptions.openaiProviderConfig.apiKeyService'
const CHAT_OPENAI_FIELD_KEYS = new Set([CHAT_OPENAI_BASE_URL_KEY, CHAT_OPENAI_API_KEY_SERVICE_KEY])

function enumOptionLabel(key: string, value: string): string {
  if (key === CHAT_OPENAI_API_KEY_SERVICE_KEY && value === '') {
    return '-- none --'
  }
  return value || '(default)'
}

function buildChatOpenAIProviderConfig(baseUrl: unknown, apiKeyService: unknown): Record<string, unknown> | null {
  const next: Record<string, unknown> = {}
  const normalizedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  const normalizedService = typeof apiKeyService === 'string' ? apiKeyService.trim() : ''
  if (normalizedBaseUrl) next.baseUrl = normalizedBaseUrl
  if (normalizedService) next.apiKeyService = normalizedService
  return Object.keys(next).length > 0 ? next : null
}

export function ConfigEditDialog({
  open,
  config,
  lineName,
  transport,
  adminPhonesDisplay,
  onClose,
}: {
  open: boolean
  config: Record<string, unknown>
  lineName: string
  transport?: string | null
  adminPhonesDisplay?: Record<string, string>
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [patch, setPatch] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [customEnumFields, setCustomEnumFields] = useState<Record<string, true>>({})
  const fieldIdPrefix = useId()
  const invalidTransport = transport !== undefined && transport !== null && !isTransportKind(transport)
  const transportKind = isTransportKind(transport) ? transport : 'baileys'
  const transportMeta = TRANSPORT_MAP[transportKind]
  const interactiveTwilio = transportKind === 'twilio' && config.type !== 'passive'

  // Reset patch and custom-enum state on each open (C-B3W2-1 — mirrors
  // CreateGroupModal precedent; provides fresh-state-per-open semantics that
  // mount-gating previously provided).
  useEffect(() => {
    if (open) {
      setPatch({})
      setCustomEnumFields({})
    }
  }, [open])

  const editableEntries: [string, unknown][] = React.useMemo(() => {
    if (invalidTransport) return []
    const entries: [string, unknown][] = []
    for (const [k, v] of Object.entries(config)) {
      if (CONFIG_EXCLUDE_KEYS.has(k)) continue
      if (!isSafeConfigPath(k)) continue
      if (k === 'agentOptions' && isRecord(v)) {
        const remaining = cloneRecord(v)
        for (const fieldKey of Object.keys(AGENT_OPTION_FIELDS)) {
          const nestedPath = fieldKey.replace(/^agentOptions\./, '')
          const fieldValue = getValueAtPath(v, nestedPath)
          if (fieldValue === undefined) continue
          deleteValueAtPath(remaining, nestedPath)
          entries.push([fieldKey, fieldValue])
        }
        if (Object.keys(remaining).length > 0) {
          entries.push(['agentOptions (other)', remaining])
        }
      } else if (k === 'chatOptions' && config.type === 'chat' && isRecord(v)) {
        const remaining = cloneRecord(v)
        for (const fieldKey of Object.keys(CHAT_OPTION_FIELDS)) {
          const nestedPath = fieldKey.replace(/^chatOptions\./, '')
          const fieldValue = getValueAtPath(v, nestedPath)
          if (fieldValue === undefined) continue
          deleteValueAtPath(remaining, nestedPath)
          entries.push([fieldKey, fieldValue])
        }
        if (Object.keys(remaining).length > 0) {
          entries.push(['chatOptions (other)', remaining])
        }
      } else {
        entries.push([k, v])
      }
    }

    if (config.type === 'chat') {
      const entryKeys = new Set(entries.map(([key]) => key))
      for (const fieldKey of Object.keys(CHAT_OPTION_FIELDS)) {
        if (!entryKeys.has(fieldKey)) entries.push([fieldKey, ''])
      }
    }
    return entries
  }, [config, invalidTransport])

  const editableEntryValues = React.useMemo(
    () => Object.fromEntries(editableEntries) as Record<string, unknown>,
    [editableEntries],
  )

  const configValue = useCallback((key: string): unknown => {
    return getValueAtPath(config, key)
  }, [config])

  const currentValue = useCallback((key: string): unknown => (
    Object.hasOwn(patch, key)
      ? patch[key]
      : Object.hasOwn(editableEntryValues, key)
        ? editableEntryValues[key]
        : configValue(key)
  ), [patch, editableEntryValues, configValue])

  const setField = useCallback((key: string, value: unknown) => {
    setPatch(prev => {
      const originalValue = Object.hasOwn(editableEntryValues, key) ? editableEntryValues[key] : configValue(key)
      if (isEqualValue(value, originalValue)) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: value }
    })
  }, [editableEntryValues, configValue])

  const getFieldError = useCallback((key: string): string | null => {
    const value = currentValue(key)
    const enumOptions = ENUM_OPTIONS[key]
    const customEnumActive = CUSTOMIZABLE_ENUM_KEYS.has(key)
      && (Object.hasOwn(customEnumFields, key) || (typeof value === 'string' && !!enumOptions && !enumOptions.includes(value)))
    if (customEnumActive && typeof value === 'string' && value.trim() === '') {
      return 'Enter a custom model ID or choose a preset'
    }
    const fieldError = key === 'adminPhones'
      ? validateAdminPhones(value, transportKind)
      : FIELD_VALIDATORS[key]?.(value) ?? null
    if (fieldError) return fieldError
    if (key === CHAT_OPENAI_BASE_URL_KEY) {
      const baseUrl = typeof value === 'string' ? value.trim() : ''
      const service = currentValue(CHAT_OPENAI_API_KEY_SERVICE_KEY)
      if (!baseUrl && typeof service === 'string' && service.trim() !== '') {
        return 'Clear keyring service before removing the custom endpoint'
      }
    }
    if (key === CHAT_OPENAI_API_KEY_SERVICE_KEY) {
      const service = typeof value === 'string' ? value : ''
      const baseUrl = currentValue(CHAT_OPENAI_BASE_URL_KEY)
      if (service && (typeof baseUrl !== 'string' || baseUrl.trim() === '')) {
        return 'Set a custom OpenAI endpoint before choosing a keyring service'
      }
    }
    return null
  }, [currentValue, customEnumFields, transportKind])

  const handleSave = async () => {
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    try {
      const apiPatch: Record<string, unknown> = {}
      const hasChatOpenAIProviderPatch = Object.keys(patch).some(key => CHAT_OPENAI_FIELD_KEYS.has(key))
      for (const [key, value] of Object.entries(patch)) {
        if (hasChatOpenAIProviderPatch && CHAT_OPENAI_FIELD_KEYS.has(key)) continue
        setValueAtPath(apiPatch, key, value)
      }
      if (hasChatOpenAIProviderPatch) {
        setValueAtPath(
          apiPatch,
          'chatOptions.openaiProviderConfig',
          buildChatOpenAIProviderConfig(
            currentValue(CHAT_OPENAI_BASE_URL_KEY),
            currentValue(CHAT_OPENAI_API_KEY_SERVICE_KEY),
          ),
        )
      }
      await api.updateConfig(lineName, apiPatch)
      toast.success('Configuration updated')
      await queryClient.invalidateQueries({ queryKey: ['lines', lineName] })
      onClose()
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const renderField = (
    key: string,
    originalValue: unknown,
    fieldId: string,
    describedBy: string | undefined,
    invalid: boolean,
  ) => {
    const val = currentValue(key)

    // Boolean -> checkbox
    if (typeof originalValue === 'boolean') {
      return (
        <CheckboxField
          id={fieldId}
          checked={val as boolean}
          onChange={checked => setField(key, checked)}
          className="cursor-pointer"
          inputClassName="accent-current w-[var(--feed-col-icon)] h-[var(--feed-col-icon)]"
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          label={(
            <span className="font-mono text-m-agt text-data">
              {String(val)}
            </span>
          )}
        />
      )
    }

    // Number -> number input
    if (typeof originalValue === 'number') {
      return (
        <NumberInput
          id={fieldId}
          value={val as number}
          onChange={e => setField(key, Number(e.target.value))}
          className="text-s-warn"
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          error={invalid}
        />
      )
    }

    // Array of strings -> TagInput
    if (Array.isArray(originalValue) && originalValue.every(v => typeof v === 'string')) {
      const values = (val as string[]) ?? []
      return (
        <TagInput
          id={fieldId}
          values={values}
          onChange={(newValues) => setField(key, newValues)}
          placeholder={key === 'adminPhones'
            ? transportKind === 'baileys' || transportKind === 'twilio'
              ? 'Add phone number'
              : transportMeta.adminIdPlaceholder
            : 'Add item'}
          validate={key === 'adminPhones' ? transportMeta.validateAdminId : undefined}
          normalizeValue={key === 'adminPhones' ? transportMeta.normalizeAdminId : undefined}
          accentColor={values.length > 0 ? 'var(--mode-agent-solid)' : undefined}
          displayLabels={key === 'adminPhones' ? adminPhonesDisplay : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
        />
      )
    }

    // Object/null -> read-only JSON textarea
    if (typeof originalValue === 'object') {
      return (
        <TextArea
          id={fieldId}
          readOnly
          value={JSON.stringify(val, null, 2)}
          className="text-text-2"
          minHeight="calc(var(--sp-10) + var(--sp-5))"
          resize="vertical"
          dimmed
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          error={invalid}
        />
      )
    }

    // String with known enum -> select
    const enumOpts = key === 'accessMode' && config.type === 'passive' ? ['self_only']
      : key === 'accessMode' && interactiveTwilio ? ['allowlist', 'open_dm']
      : Object.hasOwn(ENUM_OPTIONS, key) ? ENUM_OPTIONS[key]
      : Object.hasOwn(AGENT_OPTION_FIELDS, key) && AGENT_OPTION_FIELDS[key].type === 'enum' ? AGENT_OPTION_FIELDS[key].enum
      : null
    if (typeof originalValue === 'string' && enumOpts) {
      const customEnumActive = CUSTOMIZABLE_ENUM_KEYS.has(key)
        && (Object.hasOwn(customEnumFields, key) || !enumOpts.includes(val as string))
      const clearCustomEnum = () => {
        setCustomEnumFields(prev => {
          if (!Object.hasOwn(prev, key)) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }

      return (
        <div className="flex flex-col gap-[var(--sp-2)]">
          <SelectInput
            id={fieldId}
            value={customEnumActive ? CUSTOM_ENUM_OPTION : val as string}
            onChange={e => {
              const nextValue = e.target.value
              if (nextValue === CUSTOM_ENUM_OPTION) {
                setCustomEnumFields(prev => ({ ...prev, [key]: true }))
                setField(key, typeof val === 'string' && !enumOpts.includes(val) ? val : '')
                return
              }
              clearCustomEnum()
              setField(key, nextValue)
            }}
            className="font-mono cursor-pointer text-m-pas pr-[var(--sp-8)]"
            aria-describedby={describedBy}
            aria-invalid={invalid ? true : undefined}
            error={invalid && !customEnumActive}
          >
            {!CUSTOMIZABLE_ENUM_KEYS.has(key) && typeof val === 'string' && !enumOpts.includes(val) && (
              <option value={val} disabled>
                {enumOptionLabel(key, val)} {interactiveTwilio ? '(unavailable for Twilio SMS)' : '(unavailable)'}
              </option>
            )}
            {enumOpts.map(opt => (
              <option key={opt} value={opt}>{enumOptionLabel(key, opt)}</option>
            ))}
            {CUSTOMIZABLE_ENUM_KEYS.has(key) && (
              <option value={CUSTOM_ENUM_OPTION}>Custom…</option>
            )}
          </SelectInput>
          {customEnumActive && (
            <TextInput
              id={`${fieldId}-custom`}
              type="text"
              value={typeof val === 'string' && !enumOpts.includes(val) ? val : ''}
              onChange={e => setField(key, e.target.value)}
              aria-label="Custom model ID"
              placeholder="Enter custom model ID"
              className="text-m-pas"
              aria-describedby={describedBy}
              aria-invalid={invalid ? true : undefined}
              error={invalid}
            />
          )}
        </div>
      )
    }

    // String (long) -> textarea
    if (typeof originalValue === 'string' && (originalValue as string).length > 80) {
      return (
        <TextArea
          id={fieldId}
          value={val as string}
          onChange={e => setField(key, e.target.value)}
          className="text-m-pas"
          minHeight="calc(var(--sp-10) * 2)"
          resize="vertical"
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          error={invalid}
        />
      )
    }

    // String (short) -> text input
    return (
      <TextInput
        id={fieldId}
        type="text"
        value={val as string}
        onChange={e => setField(key, e.target.value)}
        className="text-m-pas"
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        error={invalid}
      />
    )
  }

  const hasChanges = Object.keys(patch).length > 0
  const hasErrors = invalidTransport || editableEntries.some(([key]) => {
    const isActive = Object.hasOwn(patch, key) || Object.hasOwn(customEnumFields, key)
    return isActive && getFieldError(key) !== null
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      dismissable={false}
    >
      <ModalHeader title="Edit Configuration" onClose={onClose} />

      {/* Restart warning — direct shell child between ModalHeader and ModalBody so it
          does not scroll with the body (C-B3W2-6 non-scrolling anatomy region). */}
      <div
        className="flex items-center gap-2 flex-shrink-0 py-[var(--sp-3)] px-[var(--sp-5)] bg-[var(--s-warn-wash)] c-border-b text-s-warn text-sm"
      >
        <AlertTriangle size={14} strokeWidth={1.75} />
        <span>Some changes may require a restart to take effect.</span>
      </div>

      <ModalBody>
        {invalidTransport && (
          <div className="rounded-md bg-surface-raised p-[var(--sp-3)] text-s-crit text-sm">
            Unsupported transport configuration
          </div>
        )}
        {interactiveTwilio && (
          <div className="rounded-md bg-surface-raised p-[var(--sp-3)] text-s-warn text-sm">
            Twilio SMS cannot authenticate admins or receive group chats. Interactive lines support allowlist or open_dm access only.
          </div>
        )}
        {editableEntries.map(([key, originalValue]) => {
          const isActive = Object.hasOwn(patch, key) || Object.hasOwn(customEnumFields, key)
          const fieldError = isActive ? getFieldError(key) : null
          const fieldId = `${fieldIdPrefix}-${fieldIdSegment(key)}`
          const errorId = fieldError ? `${fieldId}-error` : undefined

          return (
            <div key={key}>
              <label htmlFor={fieldId} className="c-label block mb-[var(--sp-1)]">
                {key}
                {isActive && (
                  <span
                    className="font-mono ml-[var(--sp-2)] text-s-warn text-xs"
                  >
                    modified
                  </span>
                )}
              </label>
              {renderField(key, originalValue, fieldId, errorId, Boolean(fieldError))}
              {fieldError && (
                <span id={errorId} className="font-mono block text-s-crit mt-[var(--sp-1)] text-xs">
                  {fieldError}
                </span>
              )}
            </div>
          )
        })}
      </ModalBody>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant={hasChanges ? 'primary' : 'ghost'}
          onClick={handleSave}
          disabled={saving || !hasChanges || hasErrors}
          icon={<Save size={14} strokeWidth={1.75} />}
        >
          {saving ? 'Saving...' : `Save${hasChanges ? ` (${Object.keys(patch).length})` : ''}`}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
