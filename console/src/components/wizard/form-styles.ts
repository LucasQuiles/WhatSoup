// ── Shared style constants for wizard form fields ──

export const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-d1)',
  border: 'var(--bw) solid var(--b2)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--sp-2) var(--sp-3)',
  fontSize: 'var(--font-size-data)',
  color: 'var(--color-t1)',
}

export const numberInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 120,
  textAlign: 'right',
}

export const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 'var(--sp-2)',
}

export const helperStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--color-t4)',
  marginTop: 'var(--sp-1)',
}

export const errorStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--color-s-crit)',
  marginTop: 'var(--sp-1)',
}

export const checkboxRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
}
