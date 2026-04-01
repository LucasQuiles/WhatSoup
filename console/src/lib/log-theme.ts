/** Shared log-level color and background mappings for log viewers. */

export const levelColor: Record<string, string> = {
  info: 'text-t3',
  warn: 'text-s-warn',
  error: 'text-s-crit',
  debug: 'text-t5',
}

export const levelBg: Record<string, string> = {
  info: 'var(--color-d5)',
  warn: 'var(--s-warn-wash)',
  error: 'var(--s-crit-soft)',
  debug: 'var(--color-d4)',
}

export const levelLineBg: Record<string, string> = {
  error: 'var(--s-crit-wash)',
  warn: 'var(--s-warn-wash)',
}
