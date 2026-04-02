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

export const selectStyle: React.CSSProperties = {
  ...inputStyle,
  paddingRight: 'var(--sp-8)',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7a90' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: `right var(--sp-3) center`,
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
  fontSize: 'var(--font-size-data)',
  color: 'var(--color-t4)',
  marginTop: 'var(--sp-1)',
}

export const errorStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-data)',
  color: 'var(--color-s-crit)',
  marginTop: 'var(--sp-1)',
}

export const checkboxRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
}
