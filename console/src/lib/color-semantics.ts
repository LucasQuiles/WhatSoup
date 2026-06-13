export const KPI_COLOR_TOKENS = {
  neutral: 'var(--text-2)',
  'text-s-ok': 'var(--status-ok-solid)',
  'text-s-crit': 'var(--status-crit-solid)',
  'text-s-warn': 'var(--status-warn-solid)',
  'text-m-agt': 'var(--mode-agent-solid)',
  'text-m-cht': 'var(--mode-chat-solid)',
  'text-m-pas': 'var(--mode-passive-solid)',
} as const satisfies Readonly<Record<string, string>>

export function kpiStrokeColor(color: string): string {
  return KPI_COLOR_TOKENS[color as keyof typeof KPI_COLOR_TOKENS] ?? 'currentColor'
}

export function isNeutralKpiColor(color: string): boolean {
  return color === 'neutral'
}

export const TOAST_BORDER_COLOR = {
  success: 'var(--status-ok-border)',
  error: 'var(--status-crit-border)',
  info: 'var(--mode-chat-border)',
} as const satisfies Readonly<Record<string, string>>

export const TOAST_ICON_CLASS = {
  success: 'text-s-ok',
  error: 'text-s-crit',
  info: 'text-m-cht',
} as const satisfies Readonly<Record<string, string>>

export const CONFIG_VALUE_TYPE_COLOR = {
  string: 'var(--mode-passive-solid)',
  number: 'var(--status-warn-solid)',
  boolean: 'var(--mode-agent-solid)',
  path: 'var(--mode-chat-solid)',
} as const satisfies Readonly<Record<string, string>>
