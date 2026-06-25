/**
 * FilterPill — thin wrapper over the Pill primitive (C2 migration, pill.md).
 *
 * Public prop interface preserved for zero consumer breakage.
 * Maps the old ad-hoc prop surface onto Pill's interactive variant.
 *
 * Migration notes:
 *   - aria-pressed preserved (interactive variant)
 *   - count badge preserved (Pill's built-in count lane)
 *   - suffix prop: Pill doesn't have a suffix lane; we wrap it inline
 *   - activeColor: the Pill primitive uses semantic tone tokens instead of
 *     caller-provided color strings. This prop is accepted and mapped onto a
 *     Pill tone (LEGACY_COLOR_TONE) for backward compat — it represented the
 *     anti-pattern pill.md consolidates away (per-use color overrides).
 *     Callers that need per-tone styling should use the Pill tone prop directly.
 *   - Default tone "neutral" provides the equivalent of the old text-t2 / bg-d4 style.
 *
 * Test contract: aria-pressed/click behavior preserved; the design-token state
 * contract tests were updated in the same slice to the soup-pill class contract.
 */
import { type FC, type ReactNode } from 'react'
import { Pill, type PillTone } from './primitives'

interface FilterPillProps {
  label: string
  isActive: boolean
  /**
   * @deprecated Pass tone prop to the underlying Pill directly instead.
   * Accepted for backward compat but not forwarded — use PillTone.
   */
  activeColor?: string
  onClick: () => void
  count?: number
  /** DECORATIVE content only — rendered OUTSIDE the interactive control (not part of
   *  its accessible name or pointer target). Meaningful state must live in the label. */
  suffix?: ReactNode
  /** Optional Pill tone override. Defaults to "neutral". */
  tone?: PillTone
}

/** Legacy activeColor utility-class -> Pill tone mapping, so existing callers keep
 *  their semantic toning until each is migrated to the tone prop directly. */
const LEGACY_COLOR_TONE: Record<string, PillTone> = {
  'text-s-crit': 'crit',
  'text-s-warn': 'warn',
  'text-s-ok': 'ok',
  'text-m-pas': 'passive',
  'text-m-cht': 'chat',
  'text-m-agt': 'agent',
};

const FilterPill: FC<FilterPillProps> = ({
  label,
  isActive,
  onClick,
  count,
  suffix,
  activeColor,
  tone,
}) => {
  const resolvedTone: PillTone = tone ?? ((activeColor ? LEGACY_COLOR_TONE[activeColor] : undefined) ?? 'neutral');
  return (
    <span className="inline-flex items-center gap-[var(--sp-1)]">
      <Pill
        variant="interactive"
        tone={resolvedTone}
        pressed={isActive}
        onClick={onClick}
        count={count && count > 0 ? count : undefined}
      >
        {label}
      </Pill>
      {suffix}
    </span>
  )
}

export default FilterPill
