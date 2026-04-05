// Shared types for line-detail tab components
import type { Mode, LineInstance, ChatItem, Message, AccessEntry, LogEntry, MetricsRange, LineMetrics } from '../../types'

export type { Mode, LineInstance, ChatItem, Message, AccessEntry, LogEntry, MetricsRange, LineMetrics }

export type ModeColor = 'pas' | 'cht' | 'agt'

export function getModeColor(mode: Mode): ModeColor {
  return mode === 'passive' ? 'pas' : mode === 'chat' ? 'cht' : 'agt'
}
