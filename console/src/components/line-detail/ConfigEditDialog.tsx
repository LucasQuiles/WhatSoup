import React, { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X, AlertTriangle, Save } from 'lucide-react'
import TagInput from '../TagInput'
import { normalizePhoneInput, validatePhone } from '../../lib/validation'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import {
  CONFIG_EXCLUDE_KEYS,
  AGENT_OPTION_FIELDS,
  ENUM_OPTIONS,
  CUSTOM_ENUM_OPTION,
  CUSTOMIZABLE_ENUM_KEYS,
  FIELD_VALIDATORS,
  isRecord,
  getValueAtPath,
  setValueAtPath,
  deleteValueAtPath,
  cloneRecord,
  isEqualValue,
} from './config-helpers'

export function ConfigEditDialog({
  config,
  lineName,
  adminPhonesDisplay,
  onClose,
}: {
  config: Record<string, unknown>
  lineName: string
  adminPhonesDisplay?: Record<string, string>
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [patch, setPatch] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [customEnumFields, setCustomEnumFields] = useState<Record<string, true>>({})

  const editableEntries: [string, unknown][] = React.useMemo(() => {
    const entries: [string, unknown][] = []
    for (const [k, v] of Object.entries(config)) {
      if (CONFIG_EXCLUDE_KEYS.has(k)) continue
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
      } else {
        entries.push([k, v])
      }
    }
    return entries
  }, [config])

  const editableEntryValues = React.useMemo(
    () => Object.fromEntries(editableEntries) as Record<string, unknown>,
    [editableEntries],
  )

  const configValue = useCallback((key: string): unknown => {
    return getValueAtPath(config, key)
  }, [config])

  const currentValue = useCallback((key: string): unknown => (
    key in patch ? patch[key] : key in editableEntryValues ? editableEntryValues[key] : configValue(key)
  ), [patch, editableEntryValues, configValue])

  const setField = useCallback((key: string, value: unknown) => {
    setPatch(prev => {
      const originalValue = key in editableEntryValues ? editableEntryValues[key] : configValue(key)
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
      && (key in customEnumFields || (typeof value === 'string' && !!enumOptions && !enumOptions.includes(value)))
    if (customEnumActive && typeof value === 'string' && value.trim() === '') {
      return 'Enter a custom model ID or choose a preset'
    }
    return FIELD_VALIDATORS[key]?.(value) ?? null
  }, [currentValue, customEnumFields])

  const handleSave = async () => {
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    try {
      const apiPatch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        setValueAtPath(apiPatch, key, value)
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

  const renderField = (key: string, originalValue: unknown) => {
    const val = currentValue(key)

    // Boolean -> checkbox
    if (typeof originalValue === 'boolean') {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={val as boolean}
            onChange={e => setField(key, e.target.checked)}
            className="accent-current w-[var(--feed-col-icon)] h-[var(--feed-col-icon)]"
          />
          <span className="font-mono text-m-agt text-data">
            {String(val)}
          </span>
        </label>
      )
    }

    // Number -> number input
    if (typeof originalValue === 'number') {
      return (
        <input
          type="number"
          value={val as number}
          onChange={e => setField(key, Number(e.target.value))}
          className="c-input font-mono text-s-warn"
        />
      )
    }

    // Array of strings -> TagInput
    if (Array.isArray(originalValue) && originalValue.every(v => typeof v === 'string')) {
      const values = (val as string[]) ?? []
      return (
        <TagInput
          values={values}
          onChange={(newValues) => setField(key, newValues)}
          placeholder={key === 'adminPhones' ? 'Add phone number' : 'Add item'}
          validate={key === 'adminPhones' ? validatePhone : undefined}
          normalizeValue={key === 'adminPhones' ? normalizePhoneInput : undefined}
          accentColor={values.length > 0 ? 'var(--color-m-agt)' : undefined}
          displayLabels={key === 'adminPhones' ? adminPhonesDisplay : undefined}
        />
      )
    }

    // Object -> read-only JSON textarea
    if (typeof originalValue === 'object' && originalValue !== null) {
      return (
        <textarea
          readOnly
          value={JSON.stringify(val, null, 2)}
          className="c-input font-mono text-t3"
          style={{ resize: 'vertical', minHeight: 'calc(var(--sp-10) + var(--sp-5))', filter: 'brightness(0.7)' }}
        />
      )
    }

    // String with known enum -> select
    const enumOpts = key in ENUM_OPTIONS ? ENUM_OPTIONS[key]
      : key in AGENT_OPTION_FIELDS && AGENT_OPTION_FIELDS[key].type === 'enum' ? AGENT_OPTION_FIELDS[key].enum
      : null
    if (typeof originalValue === 'string' && enumOpts) {
      const customEnumActive = CUSTOMIZABLE_ENUM_KEYS.has(key)
        && (key in customEnumFields || !enumOpts.includes(val as string))
      const clearCustomEnum = () => {
        setCustomEnumFields(prev => {
          if (!(key in prev)) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }

      return (
        <div className="flex flex-col gap-[var(--sp-2)]">
          <select
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
            className="c-input font-mono cursor-pointer text-m-pas pr-[var(--sp-8)]"
          >
            {enumOpts.map(opt => (
              <option key={opt} value={opt}>{opt || '(default)'}</option>
            ))}
            {CUSTOMIZABLE_ENUM_KEYS.has(key) && (
              <option value={CUSTOM_ENUM_OPTION}>Custom…</option>
            )}
          </select>
          {customEnumActive && (
            <input
              type="text"
              value={typeof val === 'string' && !enumOpts.includes(val) ? val : ''}
              onChange={e => setField(key, e.target.value)}
              placeholder="Enter custom model ID"
              className="c-input font-mono text-m-pas"
            />
          )}
        </div>
      )
    }

    // String (long) -> textarea
    if (typeof originalValue === 'string' && (originalValue as string).length > 80) {
      return (
        <textarea
          value={val as string}
          onChange={e => setField(key, e.target.value)}
          className="c-input font-mono text-m-pas"
          style={{ resize: 'vertical', minHeight: 'calc(var(--sp-10) * 2)' }}
        />
      )
    }

    // String (short) -> text input
    return (
      <input
        type="text"
        value={val as string}
        onChange={e => setField(key, e.target.value)}
        className="c-input font-mono text-m-pas"
      />
    )
  }

  const hasChanges = Object.keys(patch).length > 0
  const hasErrors = editableEntries.some(([key]) => {
    const isActive = key in patch || key in customEnumFields
    return isActive && getFieldError(key) !== null
  })

  return (
    <div
      className="c-dialog-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-edit-dialog-title"
        className="c-dialog flex flex-col w-[var(--panel-config-edit)] max-h-[var(--modal-max-h-sm)] max-w-[var(--panel-max-inline)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="c-dialog-header flex-shrink-0">
          <span id="config-edit-dialog-title" className="font-sans font-semibold text-lg">
            Edit Configuration
          </span>
          <button type="button" onClick={onClose} className="c-btn c-btn-ghost c-btn-sm" aria-label="Close dialog">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Restart warning */}
        <div
          className="flex items-center gap-2 flex-shrink-0 py-[var(--sp-3)] px-[var(--sp-5)] bg-[var(--s-warn-wash)] c-border-b text-s-warn text-sm"
        >
          <AlertTriangle size={14} strokeWidth={1.75} />
          <span>Some changes may require a restart to take effect.</span>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto py-[var(--sp-4)] px-[var(--sp-5)]">
          <div className="flex flex-col gap-[var(--sp-4)]">
            {editableEntries.map(([key, originalValue]) => (
              <div key={key}>
                <label className="c-label block mb-[var(--sp-1)]">
                  {key}
                  {(key in patch || key in customEnumFields) && (
                    <span
                      className="font-mono ml-[var(--sp-2)] text-s-warn text-xs"
                    >
                      modified
                    </span>
                  )}
                </label>
                {renderField(key, originalValue)}
                {(key in patch || key in customEnumFields) && getFieldError(key) && (
                  <span className="font-mono block text-s-crit mt-[var(--sp-1)] text-xs">
                    {getFieldError(key)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="c-dialog-footer">
          <button type="button" onClick={onClose} className="c-btn c-btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges || hasErrors}
            className={`c-btn ${hasChanges ? 'c-btn-primary' : 'c-btn-ghost'}`}
          >
            <Save size={14} strokeWidth={1.75} />
            {saving ? 'Saving...' : `Save${hasChanges ? ` (${Object.keys(patch).length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
