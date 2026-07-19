import { describe, it, expect } from 'vitest'
import {
  STATUS_MAP,
  MODE_MAP,
  CONNECTION_MAP,
  resolveStatus,
  resolveMode,
  resolveConnection,
  type Status,
  type Mode,
  type ConnectionState,
} from '../../console/src/lib/status-map'

describe('status-map', () => {
  describe('STATUS_MAP', () => {
    it('contains all expected line statuses', () => {
      const expectedStatuses: Status[] = [
        'online',
        'degraded',
        'unreachable',
        'logged_out',
        'config_error',
        'unknown',
        'unlinked',
      ]
      expectedStatuses.forEach((status) => {
        expect(status in STATUS_MAP).toBe(true)
        expect(STATUS_MAP[status]).toBeDefined()
      })
    })

    it('has consistent shape, token, label, and classes for each status', () => {
      const statuses = Object.keys(STATUS_MAP) as Status[]
      statuses.forEach((status) => {
        const entry = STATUS_MAP[status]
        expect(entry.shape).toBeDefined()
        expect(['disc', 'diamond', 'square', 'outline']).toContain(entry.shape)
        expect(entry.token === null || typeof entry.token === 'string').toBe(true)
        expect(typeof entry.label).toBe('string')
        expect(entry.label.length).toBeGreaterThan(0)
        expect(typeof entry.shapeClass).toBe('string')
        expect(typeof entry.labelClass).toBe('string')
      })
    })

    it('online status uses disc shape with ok token', () => {
      expect(STATUS_MAP.online.shape).toBe('disc')
      expect(STATUS_MAP.online.token).toBe('--status-ok-solid')
      expect(STATUS_MAP.online.labelToken).toBeNull()
      expect(STATUS_MAP.online.label).toBe('online')
    })

    it('degraded status uses diamond shape with warn token', () => {
      expect(STATUS_MAP.degraded.shape).toBe('diamond')
      expect(STATUS_MAP.degraded.token).toBe('--status-warn-solid')
      expect(STATUS_MAP.degraded.labelToken).toBe('--status-warn-fg')
      expect(STATUS_MAP.degraded.label).toBe('degraded')
    })

    it('critical statuses use square shape with crit token', () => {
      const criticalStatuses: Status[] = ['unreachable', 'logged_out', 'config_error']
      criticalStatuses.forEach((status) => {
        expect(STATUS_MAP[status].shape).toBe('square')
        expect(STATUS_MAP[status].token).toBe('--status-crit-solid')
        expect(STATUS_MAP[status].labelToken).toBe('--status-crit-fg')
      })
    })

    it('unlinked status uses outline shape with no token', () => {
      expect(STATUS_MAP.unlinked.shape).toBe('outline')
      expect(STATUS_MAP.unlinked.token).toBeNull()
      expect(STATUS_MAP.unlinked.label).toBe('unlinked')
    })

    it('status entries exist in the map', () => {
      expect('online' in STATUS_MAP).toBe(true)
      expect('degraded' in STATUS_MAP).toBe(true)
    })
  })

  describe('MODE_MAP', () => {
    it('contains all three operation modes', () => {
      const expectedModes: Mode[] = ['passive', 'chat', 'agent']
      expectedModes.forEach((mode) => {
        expect(mode in MODE_MAP).toBe(true)
        expect(MODE_MAP[mode]).toBeDefined()
      })
    })

    it('has consistent token, label, and class for each mode', () => {
      const modes = Object.keys(MODE_MAP) as Mode[]
      modes.forEach((mode) => {
        const entry = MODE_MAP[mode]
        expect(entry.token).toBeDefined()
        expect(typeof entry.token).toBe('string')
        expect(entry.label).toBeDefined()
        expect(typeof entry.label).toBe('string')
        expect(entry.modeClass).toBeDefined()
        expect(typeof entry.modeClass).toBe('string')
      })
    })

    it('uses distinct tokens for each mode', () => {
      const tokens = new Set<string>()
      const modes = Object.keys(MODE_MAP) as Mode[]
      modes.forEach((mode) => {
        tokens.add(MODE_MAP[mode].token)
      })
      expect(tokens.size).toBe(modes.length)
    })
  })

  describe('CONNECTION_MAP', () => {
    it('contains all connection states', () => {
      const expectedStates: ConnectionState[] = ['connected', 'connecting', 'disconnected', 'unknown']
      expectedStates.forEach((state) => {
        expect(state in CONNECTION_MAP).toBe(true)
        expect(CONNECTION_MAP[state]).toBeDefined()
      })
    })

    it('has label and inkClass for each connection state', () => {
      const states = Object.keys(CONNECTION_MAP) as ConnectionState[]
      states.forEach((state) => {
        const entry = CONNECTION_MAP[state]
        expect(entry.label).toBeDefined()
        expect(typeof entry.label).toBe('string')
        expect(entry.inkClass).toBeDefined()
        expect(typeof entry.inkClass).toBe('string')
      })
    })

    it('connected state uses ok ink class', () => {
      expect(CONNECTION_MAP.connected.label).toBe('connected')
      expect(CONNECTION_MAP.connected.inkClass).toBe('text-s-ok')
    })

    it('connecting state uses warn ink class', () => {
      expect(CONNECTION_MAP.connecting.label).toBe('connecting')
      expect(CONNECTION_MAP.connecting.inkClass).toBe('text-s-warn')
    })

    it('disconnected state uses crit ink class', () => {
      expect(CONNECTION_MAP.disconnected.label).toBe('disconnected')
      expect(CONNECTION_MAP.disconnected.inkClass).toBe('text-s-crit')
    })
  })

  describe('resolveStatus', () => {
    it('returns the status entry for known statuses', () => {
      const status = resolveStatus('online')
      expect(status).toEqual(STATUS_MAP.online)
    })

    it('returns unlinked outline for unknown status values', () => {
      const unknown = resolveStatus('unknown-status-value')
      expect(unknown.shape).toBe('outline')
      expect(unknown.label).toBe('unknown-status-value')
    })

    it('preserves unknown value in label for fail-visible rendering', () => {
      const customValue = 'custom_status'
      const resolved = resolveStatus(customValue)
      expect(resolved.label).toBe(customValue)
    })
  })

  describe('resolveMode', () => {
    it('returns the mode entry for known modes', () => {
      const mode = resolveMode('passive')
      expect(mode).toEqual(MODE_MAP.passive)
    })

    it('returns null for unknown mode values', () => {
      expect(resolveMode('unknown-mode')).toBeNull()
      expect(resolveMode('')).toBeNull()
      expect(resolveMode('AGENT')).toBeNull() // Case-sensitive
    })
  })

  describe('resolveConnection', () => {
    it('returns the connection entry for known states', () => {
      const state = resolveConnection('connected')
      expect(state).toEqual(CONNECTION_MAP.connected)
    })

    it('returns neutral ink for unknown connection states', () => {
      const unknown = resolveConnection('unknown-connection')
      expect(unknown.label).toBe('unknown-connection')
      expect(unknown.inkClass).toBe('text-text-2')
    })

    it('preserves unknown value in label for fail-visible rendering', () => {
      const customValue = 'custom_connection_state'
      const resolved = resolveConnection(customValue)
      expect(resolved.label).toBe(customValue)
    })
  })
})
