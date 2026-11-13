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
  ConsoleLockedError: class ConsoleLockedError extends Error {},
}))

import { useConsoleSession } from '../../console/src/hooks/use-console-session'
import { ConsoleLockedError } from '../../console/src/lib/api'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  sessionStorage.clear()
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
    expect(result.current.notice).toBe('revocation_unconfirmed')
  })

  it('closes local access immediately and coalesces duplicate lock requests', async () => {
    let resolve!: () => void
    mockLockConsole.mockReturnValue(new Promise<void>(done => { resolve = done }))
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('unlocked'))
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.onLock()
      second = result.current.onLock()
    })
    expect(result.current.state).toBe('locked')
    expect(result.current.notice).toBe('revocation_pending')
    expect(mockLockConsole).toHaveBeenCalledOnce()
    await act(async () => { resolve(); await Promise.all([first, second]) })
    expect(result.current.notice).toBeNull()
    expect(result.current.state).toBe('locked')
  })

  it('keeps an unconfirmed lock closed after remount and supports explicit revocation retry', async () => {
    mockLockConsole.mockRejectedValueOnce(new Error('response lost'))
    const first = renderHook(() => useConsoleSession())
    await waitFor(() => expect(first.result.current.state).toBe('unlocked'))
    await act(async () => { await first.result.current.onLock() })
    first.unmount()
    mockGetApiTicket.mockClear()
    const second = renderHook(() => useConsoleSession())
    await waitFor(() => expect(second.result.current.state).toBe('locked'))
    expect(second.result.current.notice).toBe('revocation_unconfirmed')
    expect(mockGetApiTicket).not.toHaveBeenCalled()
    await act(async () => { await second.result.current.onRetry() })
    expect(second.result.current.notice).toBeNull()
    expect(mockLockConsole).toHaveBeenCalledTimes(2)
  })

  it('does not let an older successful probe reopen a requested lock', async () => {
    let resolve!: (ticket: string) => void
    mockGetApiTicket.mockReturnValue(new Promise<string>(done => { resolve = done }))
    const { result } = renderHook(() => useConsoleSession())
    await act(async () => { await result.current.onLock() })
    await act(async () => { resolve('old-probe') })
    expect(result.current.state).toBe('locked')
  })

  it('ignores stale rejected probes after a newer unlock succeeds', async () => {
    let reject!: (error: Error) => void
    mockGetApiTicket.mockReturnValue(new Promise<string>((_done, fail) => { reject = fail }))
    const { result } = renderHook(() => useConsoleSession())
    act(() => result.current.onUnlocked())
    await act(async () => { reject(new ConsoleLockedError()) })
    expect(mockGetApiTicket).toHaveBeenCalledTimes(1)
    expect(mockLockConsole).not.toHaveBeenCalled()
    expect({ state: result.current.state, notice: result.current.notice }).toEqual({ state: 'unlocked', notice: null })
  })

  it('cannot unlock or start a probe while revocation is still pending', async () => {
    let resolve!: () => void
    mockLockConsole.mockReturnValue(new Promise<void>(done => { resolve = done }))
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('unlocked'))
    let pending!: Promise<void>
    let retry!: Promise<void>
    act(() => {
      pending = result.current.onLock()
      result.current.onUnlocked()
      retry = result.current.onRetry()
    })
    expect(retry).toBe(pending)
    expect(result.current.state).toBe('locked')
    expect(result.current.notice).toBe('revocation_pending')
    expect(mockGetApiTicket).toHaveBeenCalledOnce()
    await act(async () => { resolve(); await pending })
    expect(result.current.state).toBe('locked')
  })

  it.each(['confirmed', 'failed'] as const)('retains reload lock intent when %s revocation settles after unmount', async (outcome) => {
    let settle!: () => void
    mockLockConsole.mockReturnValue(new Promise<void>((resolve, reject) => {
      settle = () => outcome === 'confirmed' ? resolve() : reject(new Error('response lost'))
    }))
    const first = renderHook(() => useConsoleSession())
    await waitFor(() => expect(first.result.current.state).toBe('unlocked'))
    let pending!: Promise<void>
    act(() => { pending = first.result.current.onLock() })
    first.unmount()
    await act(async () => { settle(); await pending })
    expect(sessionStorage.getItem('whatsoup.console.lock-requested')).toBe('1')
    mockGetApiTicket.mockClear()
    const second = renderHook(() => useConsoleSession())
    expect(second.result.current.state).toBe('locked')
    expect(second.result.current.notice).toBe('revocation_unconfirmed')
    expect(mockGetApiTicket).not.toHaveBeenCalled()
  })

  it('reports when failed revocation cannot preserve its lock request across reload', async () => {
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('unlocked'))
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    mockLockConsole.mockRejectedValueOnce(new Error('offline'))
    try {
      await act(async () => { await result.current.onLock() })
      expect(result.current.state).toBe('locked')
      expect(result.current.notice).toBe('revocation_unconfirmed')
      expect(result.current.lockPersistenceError).toBe(true)
    } finally { write.mockRestore() }
  })

  it('does not probe into an open session when stored lock intent cannot be read', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    try {
      const { result } = renderHook(() => useConsoleSession())
      expect(result.current.state).toBe('locked')
      expect(mockGetApiTicket).not.toHaveBeenCalled()
      await act(async () => { await result.current.onRetry() })
      expect(mockLockConsole).toHaveBeenCalledOnce()
      expect(result.current.notice).toBeNull()
    } finally { read.mockRestore() }
  })

  it.each(['unlock', 'confirmed revocation'] as const)('keeps failed marker removal visible after %s and can recover', async (operation) => {
    sessionStorage.setItem('whatsoup.console.lock-requested', '1')
    const { result } = renderHook(() => useConsoleSession())
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage denied') })
    try {
      await act(async () => {
        if (operation === 'unlock') result.current.onUnlocked()
        else await result.current.onLock()
      })
      expect(result.current.state).toBe('locked')
      expect(result.current.notice).toBe('lock_storage_unavailable')
      await act(async () => { await result.current.onRetry() })
      expect(mockGetApiTicket).not.toHaveBeenCalled()
      expect(mockLockConsole).toHaveBeenCalledTimes(operation === 'unlock' ? 0 : 1)
    } finally { remove.mockRestore() }
    if (operation === 'confirmed revocation') mockGetApiTicket.mockRejectedValueOnce(new ConsoleLockedError())
    await act(async () => { await result.current.onRetry() })
    expect(sessionStorage.getItem('whatsoup.console.lock-requested')).toBeNull()
    expect(result.current.notice).toBeNull()
    expect(result.current.state).toBe(operation === 'unlock' ? 'unlocked' : 'locked')
  })

  it('in dev mode (no production meta) the gate stays open and never probes', async () => {
    mockIsProductionConsole.mockReturnValue(false)
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('dev'))
    expect(mockGetApiTicket).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Probe-failure catch branch (lines 27–32): 401 / network errors map to locked
// ---------------------------------------------------------------------------

describe('useConsoleSession probe-failure → locked (lines 27–32)', () => {
  beforeEach(() => {
    mockIsProductionConsole.mockReturnValue(true)
    mockLockConsole.mockResolvedValue(undefined)
  })

  it('401-style rejection during initial probe maps to locked state', async () => {
    mockGetApiTicket.mockRejectedValue(new ConsoleLockedError())
    const { result } = renderHook(() => useConsoleSession())

    await waitFor(() => expect(result.current.state).toBe('locked'))
    // probe was attempted
    expect(mockGetApiTicket).toHaveBeenCalledOnce()
  })

  it('keeps local access closed but distinguishes an unavailable session check', async () => {
    mockGetApiTicket.mockRejectedValue(new Error('Network Error'))
    const { result } = renderHook(() => useConsoleSession())

    await waitFor(() => expect(result.current.state).toBe('locked'))
    expect(mockGetApiTicket).toHaveBeenCalledOnce()
    expect(result.current.notice).toBe('session_unavailable')
    mockGetApiTicket.mockResolvedValueOnce('recovered-ticket')
    await act(async () => { await result.current.onRetry() })
    expect(result.current.state).toBe('unlocked')
    expect(result.current.notice).toBeNull()
    expect(mockGetApiTicket).toHaveBeenCalledTimes(2)
  })

  it('onUnlocked transitions from locked to unlocked without re-probing', async () => {
    // Start with a failed probe → locked
    mockGetApiTicket.mockRejectedValue(new Error('401'))
    const { result } = renderHook(() => useConsoleSession())
    await waitFor(() => expect(result.current.state).toBe('locked'))

    await act(async () => { result.current.onUnlocked() })

    expect(result.current.state).toBe('unlocked')
  })

  it('does not update state when a successful probe resolves after unmount', async () => {
    let resolveTicket!: (ticket: string) => void
    mockGetApiTicket.mockReturnValue(new Promise<string>((resolve) => {
      resolveTicket = resolve
    }))

    const { result, unmount } = renderHook(() => useConsoleSession())
    expect(result.current.state).toBe('checking')

    unmount()
    await act(async () => {
      resolveTicket('ticket-after-unmount')
      await Promise.resolve()
    })

    expect(mockGetApiTicket).toHaveBeenCalledOnce()
  })
})
