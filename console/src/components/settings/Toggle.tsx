/**
 * SettingsToggle — the 32×18 settings toggle (mockup .tgl; 17-settings-ia-spec
 * §3: shape-visible in BOTH states — track + knob positions differ, never
 * color-only). role=switch; disabled states must carry the reason.
 */
export function SettingsToggle({
  on,
  disabled,
  label,
  reason,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  label: string
  /** Why the control is disabled (surfaced to tooltip + AT). */
  reason?: string
  onChange?: (next: boolean) => void
}) {
  return (
    <span
      className={`settings-tgl${on ? ' settings-tgl--on' : ''}${disabled ? ' settings-tgl--off' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-description={disabled ? reason : undefined}
      title={disabled ? reason : undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (!disabled) onChange?.(!on)
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onChange?.(!on)
        }
      }}
    />
  )
}
