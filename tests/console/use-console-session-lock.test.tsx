/**
 * @vitest-environment jsdom
 *
 * B1 / B14: console logout. onLock revokes the server session and relocks the
 * gate so the UnlockScreen shows again — even if the revoke call fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, renderHook, act, waitFor } from '@testing-library/react'

const mockLockConsole = vi.hoisted(() => vi.fn())
const mockGetApiTicket = vi.hoisted(() => vi.fn())
const mockIsProductionConsole = vi.hoisted(() => vi.fn())

vi.mock('../../console/src/lib/api', () => ({
  lockConsole: mockLockConsole,
  getApiTicket: mockGetApiTicket,
  isProductionConsole: mockIsProductionConsole,
}))

import { useConsoleSession } from '../../console/src/hooks/use-console-session'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useConsoleSession onLock', () => {
  beforeEach(() => {
    mockIsProductionConsole.mockReturnValue(true)
    mockGetApiTicket.mockResolvedValue('ticket-abc') // initial probe → unlocked
    mockLockConsole.mockResolvedValue(undefined)
  })

  it('starts unlocked after a successful probe, then relocks on onLock', async () => {
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('unlocked'))

    await act(async () => { await result.current.onLock() })

    expect(mockLockConsole).toHaveBeenCalledOnce()
    expect(result.current.state).toBe('locked')
  })

  it('relocks even when the server revoke call fails', async () => {
    mockLockConsole.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('unlocked'))

    await act(async () => { await result.current.onLock() })

    expect(result.current.state).toBe('locked')
  })

  it('in dev mode (no production meta) the gate stays open and never probes', async () => {
    mockIsProductionConsole.mockReturnValue(false)
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('dev'))
    expect(mockGetApiTicket).not.toHaveBeenCalled()
  })
})
