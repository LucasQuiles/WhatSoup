import { describe, expect, it } from 'vitest'
import {
  CONFIG_VALUE_TYPE_COLOR,
  KPI_COLOR_TOKENS,
  TOAST_BORDER_COLOR,
  TOAST_ICON_CLASS,
  isNeutralKpiColor,
  kpiStrokeColor,
} from '../../console/src/lib/color-semantics'

describe('color-semantics library maps', () => {
  it('centralizes KPI color tokens and unknown fallback behavior', () => {
    expect(KPI_COLOR_TOKENS).toMatchObject({
      neutral: 'var(--text-2)',
      'text-s-ok': 'var(--status-ok-solid)',
      'text-s-crit': 'var(--status-crit-solid)',
      'text-s-warn': 'var(--status-warn-solid)',
      'text-m-agt': 'var(--mode-agent-solid)',
      'text-m-cht': 'var(--mode-chat-solid)',
      'text-m-pas': 'var(--mode-passive-solid)',
    })
    expect(kpiStrokeColor('text-m-cht')).toBe('var(--mode-chat-solid)')
    expect(kpiStrokeColor('unknown-token')).toBe('currentColor')
    expect(isNeutralKpiColor('neutral')).toBe(true)
    expect(isNeutralKpiColor('text-s-ok')).toBe(false)
  })

  it('centralizes toast variant presentation tokens', () => {
    expect(TOAST_BORDER_COLOR).toEqual({
      success: 'var(--status-ok-border)',
      error: 'var(--status-crit-border)',
      info: 'var(--mode-chat-border)',
    })
    expect(TOAST_ICON_CLASS).toEqual({
      success: 'text-s-ok',
      error: 'text-s-crit',
      info: 'text-m-cht',
    })
  })

  it('centralizes config value type colors for line detail tabs', () => {
    expect(CONFIG_VALUE_TYPE_COLOR).toEqual({
      string: 'var(--mode-passive-solid)',
      number: 'var(--status-warn-solid)',
      boolean: 'var(--mode-agent-solid)',
      path: 'var(--mode-chat-solid)',
    })
  })
})
