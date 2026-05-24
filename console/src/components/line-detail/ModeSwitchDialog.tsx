import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GitBranch, AlertTriangle } from 'lucide-react'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import ConfirmDialog from '../ConfirmDialog'
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

  const handleConfirm = async () => {
    if (selected === currentMode) {
      onClose()
      return
    }
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
      onConfirm={handleConfirm}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-[var(--sp-3)]">
        <p className="text-t3 text-[var(--font-size-sm)] mb-[var(--sp-2)]">
          Select the operating mode for this instance. The instance will restart after switching.
        </p>
        {MODE_OPTIONS.map(opt => {
          const isSelected = selected === opt.value
          const isCurrent = currentMode === opt.value
          const mk = modeKey(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => !switching && setSelected(opt.value)}
              className={`flex items-start gap-3 text-left cursor-pointer c-hover py-[var(--sp-3)] px-[var(--sp-4)] rounded-md ${switching ? 'opacity-60' : ''}`}
              style={{
                borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: isSelected ? `var(--m-${mk}-soft)` : 'var(--b1)',
                background: isSelected ? `var(--m-${mk}-wash)` : 'var(--color-d1)',
              }}
            >
              {/* Radio indicator */}
              <span
                className="flex-shrink-0 rounded-full w-[var(--feed-col-icon)] h-[var(--feed-col-icon)] mt-[var(--bw-accent)]"
                style={{
                  borderWidth: 'var(--bw-accent)', borderStyle: 'solid', borderColor: isSelected ? `var(--color-m-${mk})` : 'var(--b3)',
                  background: isSelected ? `var(--color-m-${mk})` : 'transparent',
                  boxShadow: isSelected ? `inset 0 0 0 3px var(--color-d2)` : 'none',
                }}
              />
              <div>
                <div className="font-sans font-medium text-[var(--font-size-body)]" style={{ color: isSelected ? `var(--color-m-${mk})` : 'var(--color-t2)' }}>
                  {opt.label}
                  {isCurrent && (
                    <span
                      className="font-mono ml-[var(--sp-2)] text-[var(--font-size-xs)] text-t4"
                    >
                      current
                    </span>
                  )}
                </div>
                <div className="text-t4 text-[var(--font-size-sm)]">
                  {opt.description}
                </div>
              </div>
            </button>
          )
        })}
        {changed && (
          <div
            className="flex items-center gap-2 py-[var(--sp-2)] px-[var(--sp-3)] rounded-sm bg-[var(--s-warn-wash)] text-[var(--font-size-sm)] text-s-warn"
          >
            <AlertTriangle size={13} strokeWidth={1.75} />
            <span>This will restart the instance. Active sessions will be interrupted.</span>
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}
