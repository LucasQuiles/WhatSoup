import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GitBranch, AlertTriangle } from 'lucide-react'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import ConfirmDialog from '../ConfirmDialog'
import { Button } from '../primitives/Button'
import type { Mode } from './types'

const MODE_OPTIONS: { value: Mode; label: string; description: string }[] = [
  { value: 'passive', label: 'Passive', description: 'Listen and store messages. No responses.' },
  { value: 'chat', label: 'Chat', description: 'API-powered responses with access control.' },
  { value: 'agent', label: 'Agent', description: 'Full autonomous agent with tool use.' },
]

export function ModeSwitchDialog({
  currentMode,
  lineName,
  onClose,
}: {
  currentMode: Mode
  lineName: string
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Mode>(currentMode)
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)

  const handleConfirm = async () => {
    if (selected === currentMode) {
      onClose()
      return
    }
    if (switchingRef.current) return
    switchingRef.current = true
    setSwitching(true)
    try {
      await api.updateConfig(lineName, { type: selected })
      await api.restart(lineName)
      toast.success(`Switched to ${selected} mode — restarting...`)
      await queryClient.invalidateQueries({ queryKey: ['lines', lineName] })
      onClose()
    } catch (e) {
      toast.error(`Mode switch failed: ${(e as Error).message}`)
    } finally {
      switchingRef.current = false
      setSwitching(false)
    }
  }

  const modeKey = (m: Mode) => m === 'passive' ? 'pas' : m === 'chat' ? 'cht' : 'agt'
  const changed = selected !== currentMode

  return (
    <ConfirmDialog
      open
      title={`Switch ${lineName} Mode`}
      confirmLabel={changed ? `Switch to ${selected}` : 'No change'}
      confirmVariant="primary"
      confirmIcon={<GitBranch size={14} strokeWidth={1.75} />}
      confirmDisabled={switching}
      confirmLoading={switching}
      onConfirm={handleConfirm}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-[var(--sp-3)]">
        <p className="text-text-2 mb-[var(--sp-2)] text-sm">
          Select the operating mode for this instance. The instance will restart after switching.
        </p>
        <div role="group" aria-label="Operating mode" className="flex flex-col gap-[var(--sp-3)]">
        {MODE_OPTIONS.map(opt => {
          const isSelected = selected === opt.value
          const isCurrent = currentMode === opt.value
          const mk = modeKey(opt.value)
          return (
            <Button
              key={opt.value}
              variant="ghost"
              aria-pressed={isSelected}
              onClick={() => !switching && setSelected(opt.value)}
              disabled={switching}
              className="flex items-start gap-3 text-left cursor-pointer c-hover rounded-md py-[var(--sp-3)] px-[var(--sp-4)]"
              style={{
                borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: isSelected ? `var(--m-${mk}-soft)` : 'var(--border-hairline)',
                background: isSelected ? `var(--m-${mk}-wash)` : 'var(--surface-inset)',
                opacity: switching ? 0.6 : 1,
              }}
            >
              {/* Selection indicator (decorative; state conveyed via aria-pressed) */}
              <span
                aria-hidden="true"
                className="flex-shrink-0 rounded-full w-[var(--feed-col-icon)] h-[var(--feed-col-icon)]"
                style={{
                  marginTop: 'var(--bw-accent)',
                  borderWidth: 'var(--bw-accent)', borderStyle: 'solid', borderColor: isSelected ? `var(--color-m-${mk})` : 'var(--border-strong)',
                  background: isSelected ? `var(--color-m-${mk})` : 'transparent',
                  boxShadow: isSelected ? `inset 0 0 0 3px var(--surface-raised)` : 'none',
                }}
              />
              <div>
                <div className="font-sans font-medium text-body" style={{ color: isSelected ? `var(--color-m-${mk})` : 'var(--text-2)' }}>
                  {opt.label}
                  {isCurrent && (
                    <span
                      className="font-mono ml-[var(--sp-2)] text-text-2 text-xs"
                    >
                      current
                    </span>
                  )}
                </div>
                <div className="text-text-2 text-sm">
                  {opt.description}
                </div>
              </div>
            </Button>
          )
        })}
        </div>
        {changed && (
          <div
            className="flex items-center gap-2 rounded-sm bg-[var(--s-warn-wash)] text-s-warn py-[var(--sp-2)] px-[var(--sp-3)] text-sm"
          >
            <AlertTriangle size={13} strokeWidth={1.75} />
            <span>This will restart the instance. Active sessions will be interrupted.</span>
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}
