// ── Shared style constants for wizard form fields ──
// Dynamic values that must stay in JS (computed from props)

export function getBorderColor(error?: boolean, confirmed?: boolean): string {
  if (error) return 'var(--color-s-crit)'
  if (confirmed) return 'var(--wizard-accent)'
  return 'var(--b2)'
}

export const confirmCheckStyle: React.CSSProperties = {
  color: 'var(--wizard-accent)',
  flexShrink: 0,
}

// Static styles — use CSS classes from index.css instead of inline styles:
// inputStyle     → className="c-input"
// selectStyle    → className="c-input c-select"  (c-select overrides c-input's padding-right)
// numberInputStyle → className="c-input c-input-number"
// labelStyle     → className="c-field-label"
// helperStyle    → className="c-helper"
// errorStyle     → className="c-error"
// checkboxRowStyle → className="c-checkbox-row"
