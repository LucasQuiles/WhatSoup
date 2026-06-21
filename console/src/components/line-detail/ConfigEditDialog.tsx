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
import { normalizePhoneInput, validatePhone } from '../../lib/validation'
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

function fieldIdSegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'field'
}

export function ConfigEditDialog({
  open,
  config,
  lineName,
  adminPhonesDisplay,
  onClose,
}: {
  open: boolean
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
  const fieldIdPrefix = useId()

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
          placeholder={key === 'adminPhones' ? 'Add phone number' : 'Add item'}
          validate={key === 'adminPhones' ? validatePhone : undefined}
          normalizeValue={key === 'adminPhones' ? normalizePhoneInput : undefined}
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
            {enumOpts.map(opt => (
              <option key={opt} value={opt}>{opt || '(default)'}</option>
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
  const hasErrors = editableEntries.some(([key]) => {
    const isActive = key in patch || key in customEnumFields
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
        {editableEntries.map(([key, originalValue]) => {
          const isActive = key in patch || key in customEnumFields
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
