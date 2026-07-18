/**
 * Behavior coverage for console/src/hooks/use-update-check.ts
 *
 * Source facts:
 *  - queryKey: ['version']
 *  - queryFn: api.getVersion() — plain apiFetch, no withFallback wrapper.
 *    Network errors propagate as thrown; react-query catches and sets query.error.
 *  - refetchInterval: 60 * 60 * 1000 ms (3 600 000 ms — NOT 60 000 ms like use-metrics).
 *  - refetchOnMount: true (explicit, not react-query's default).
 *  - Effect: fires toast.info() exactly once when updateAvailable turns true.
 *    notifiedRef.current guards re-notification on re-renders.
 *    notifiedRef resets to false when data arrives with updateAvailable: false.
 *  - Returns spread query + showUpdateModal (false), openUpdateModal, closeUpdateModal.
 *  - getStaticVersion(): reads meta[name="fleet-version"].content from DOM,
 *    returns 'unknown' when meta absent or content is empty string.
 *
 * Test strategy:
 *  - Modal state / toast effect: renderHook with per-test QueryClient + ToastContext.
 *  - Async query settlement: waitFor (not wall-clock sleeps, not fake timers).
 *  - getStaticVersion: stub document.querySelector.
 *  - Query shape: observe the QueryClient entry configured by the hook.
 *
 * @vitest-environment jsdom
 */
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { UpdateState, useUpdateCheck } from '../../console/src/hooks/use-update-check'

// ---------------------------------------------------------------------------
// Module mocks — declared before any dynamic imports of the hook.
// ---------------------------------------------------------------------------

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getVersion: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpdateState(updateAvailable: boolean): UpdateState {
  return {
    sha: 'abc123def456abc123def456abc123de',
    remoteSha: updateAvailable
      ? 'deadbeefdeadbeefdeadbeefdeadbeef'
      : 'abc123def456abc123def456abc123de',
    updateAvailable,
    checkedAt: '2026-05-12T12:00:00.000Z',
  }
}

function makeToastContext(): ToastContextValue & { info: Mock; success: Mock; error: Mock; toast: Mock; dismiss: Mock; clear: Mock } {
  return {
    toast: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }
}

/** Create a fresh per-test QueryClient (no caching bleed between tests). */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  })
}

/** Wrapper factory — provides QueryClient + ToastContext. */
function makeWrapper(toastCtx: ToastContextValue) {
  const qc = makeQueryClient()
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        ToastContext.Provider,
        { value: toastCtx },
        children,
      ),
    )
  }
  return { wrapper: Wrapper, qc }
}

// ---------------------------------------------------------------------------
// 1. Hook return shape
// ---------------------------------------------------------------------------

describe('useUpdateCheck — return shape', () => {
  it('returns showUpdateModal, openUpdateModal, closeUpdateModal alongside query fields', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {})) // pending

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    expect(result.current).toHaveProperty('showUpdateModal')
    expect(result.current).toHaveProperty('openUpdateModal')
    expect(result.current).toHaveProperty('closeUpdateModal')
    expect(typeof result.current.openUpdateModal).toBe('function')
    expect(typeof result.current.closeUpdateModal).toBe('function')
  })

  it('also returns react-query fields (data, isLoading, isError)', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {})) // pending

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    expect(result.current).toHaveProperty('data')
    expect(result.current).toHaveProperty('isLoading')
    expect(result.current).toHaveProperty('isError')
  })
})

// ---------------------------------------------------------------------------
// 2. Initial state
// ---------------------------------------------------------------------------

describe('useUpdateCheck — initial state', () => {
  it('showUpdateModal starts as false', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })
    expect(result.current.showUpdateModal).toBe(false)
  })

  it('data is undefined and query is in pending state before the query resolves', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook<ReturnType<typeof useUpdateCheck>, unknown>(() => useUpdateCheck(), { wrapper })
    expect(result.current.data).toBeUndefined()
    // isPending (or isLoading) should be true while the query is in-flight
    // Use || instead of ?? because isPending is boolean (never nullish); ?? would narrow the rhs to never.
    expect(result.current.isPending || result.current.isLoading).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Query data — success paths
// ---------------------------------------------------------------------------

describe('useUpdateCheck — query success (no update)', () => {
  it('data.updateAvailable is false when server reports no update', async () => {
    const { api } = await import('../../console/src/lib/api')
    const mockData = makeUpdateState(false)
    ;(api.getVersion as Mock).mockResolvedValueOnce(mockData)

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())

    expect(result.current.data?.updateAvailable).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it('data carries sha, remoteSha, and checkedAt fields', async () => {
    const { api } = await import('../../console/src/lib/api')
    const mockData = makeUpdateState(false)
    ;(api.getVersion as Mock).mockResolvedValueOnce(mockData)

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())

    expect(result.current.data?.sha).toBe(mockData.sha)
    expect(result.current.data?.remoteSha).toBe(mockData.remoteSha)
    expect(result.current.data?.checkedAt).toBe(mockData.checkedAt)
  })
})

describe('useUpdateCheck — query success (update available)', () => {
  it('data.updateAvailable is true when server reports an update', async () => {
    const { api } = await import('../../console/src/lib/api')
    const mockData = makeUpdateState(true)
    ;(api.getVersion as Mock).mockResolvedValueOnce(mockData)

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())

    expect(result.current.data?.updateAvailable).toBe(true)
  })

  it('sha and remoteSha differ when an update is available', async () => {
    const { api } = await import('../../console/src/lib/api')
    const mockData = makeUpdateState(true)
    ;(api.getVersion as Mock).mockResolvedValueOnce(mockData)

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())

    expect(result.current.data?.sha).not.toBe(result.current.data?.remoteSha)
  })
})

// ---------------------------------------------------------------------------
// 4. Query error path
// ---------------------------------------------------------------------------

describe('useUpdateCheck — query error (no withFallback)', () => {
  it('isError becomes true when api.getVersion rejects', async () => {
    // getVersion has no withFallback wrapper — errors reach react-query's error state.
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockRejectedValueOnce(new Error('API 503: Service Unavailable'))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))

    // data must be absent; the error object must carry the rejection message
    expect((result.current.error as Error).message).toContain('503')
    expect(result.current.data).toBeUndefined()
    expect(result.current.isSuccess).toBe(false)
  })

  it('error object contains the rejection message', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockRejectedValueOnce(new Error('API 503: Service Unavailable'))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect((result.current.error as Error).message).toContain('503')
    expect(result.current.isSuccess).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Modal state — open / close / idempotency
// ---------------------------------------------------------------------------

describe('useUpdateCheck — modal state', () => {
  it('openUpdateModal sets showUpdateModal to true', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    act(() => {
      result.current.openUpdateModal()
    })

    expect(result.current.showUpdateModal).toBe(true)
  })

  it('closeUpdateModal sets showUpdateModal back to false', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    act(() => { result.current.openUpdateModal() })
    expect(result.current.showUpdateModal).toBe(true)

    act(() => { result.current.closeUpdateModal() })
    expect(result.current.showUpdateModal).toBe(false)
  })

  it('openUpdateModal is idempotent — calling twice keeps it true', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    act(() => {
      result.current.openUpdateModal()
      result.current.openUpdateModal()
    })
    expect(result.current.showUpdateModal).toBe(true)
  })

  it('closeUpdateModal is a no-op when modal is already closed', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    act(() => { result.current.closeUpdateModal() })
    expect(result.current.showUpdateModal).toBe(false)
  })

  it('open/close/open cycles work correctly', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    act(() => { result.current.openUpdateModal() })
    expect(result.current.showUpdateModal).toBe(true)

    act(() => { result.current.closeUpdateModal() })
    expect(result.current.showUpdateModal).toBe(false)

    act(() => { result.current.openUpdateModal() })
    expect(result.current.showUpdateModal).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Toast notification — effect behaviour
// ---------------------------------------------------------------------------

describe('useUpdateCheck — toast notification', () => {
  it('fires toast.info exactly once when updateAvailable is true', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockResolvedValueOnce(makeUpdateState(true))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const toastCtx = makeToastContext()
    const { wrapper } = makeWrapper(toastCtx)

    renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(toastCtx.info).toHaveBeenCalledTimes(1))

    expect(toastCtx.info).toHaveBeenCalledWith(
      expect.stringContaining('new version'),
    )
  })

  it('toast message directs the operator to deploy a new release', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockResolvedValueOnce(makeUpdateState(true))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const toastCtx = makeToastContext()
    const { wrapper } = makeWrapper(toastCtx)

    renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(toastCtx.info).toHaveBeenCalledTimes(1))

    // In-place update was retired (S-03); the toast no longer points at an
    // install button. Source: toast.info('A new version is available. Deploy a
    // new release to update this instance — in-place update has been retired.')
    expect(toastCtx.info).toHaveBeenCalledWith(
      expect.stringContaining('Deploy a new release'),
    )
  })

  it('does not fire toast.info when updateAvailable is false', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockResolvedValueOnce(makeUpdateState(false))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const toastCtx = makeToastContext()
    const { wrapper } = makeWrapper(toastCtx)

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data?.updateAvailable).toBe(false))
    expect(result.current.isSuccess).toBe(true)
    expect(toastCtx.info).not.toHaveBeenCalled()
    expect(toastCtx.success).not.toHaveBeenCalled()
    expect(toastCtx.error).not.toHaveBeenCalled()
  })

  it('does not fire toast on network error (data stays undefined)', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockRejectedValueOnce(new Error('API 503: unavailable'))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const toastCtx = makeToastContext()
    const { wrapper } = makeWrapper(toastCtx)

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
    expect(toastCtx.info).not.toHaveBeenCalled()
  })

  it('notifiedRef prevents duplicate toasts across re-renders with same updateAvailable=true data', async () => {
    // The effect only fires when notifiedRef.current is false.
    // Once set, re-renders with the same data do not re-trigger the toast.
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockResolvedValue(makeUpdateState(true))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const toastCtx = makeToastContext()
    const { wrapper } = makeWrapper(toastCtx)

    const { rerender } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(toastCtx.info).toHaveBeenCalledTimes(1))

    // Force additional renders — ref is still true, toast must not fire again
    rerender()
    rerender()

    expect(toastCtx.info).toHaveBeenCalledTimes(1)
  })

  it('notifiedRef resets to false when updateAvailable flips to false, allowing a future re-notification', async () => {
    // Source: if (query.data && !query.data.updateAvailable) { notifiedRef.current = false }
    // Pattern: update -> toast fires (ref true); no-update -> ref false;
    //          update again -> toast fires again.
    const { api } = await import('../../console/src/lib/api')

    ;(api.getVersion as Mock)
      .mockResolvedValueOnce(makeUpdateState(true))
      .mockResolvedValueOnce(makeUpdateState(false))
      .mockResolvedValueOnce(makeUpdateState(true))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const toastCtx = makeToastContext()
    const qc = makeQueryClient()

    function Wrapper({ children }: { children: ReactNode }) {
      return createElement(
        QueryClientProvider,
        { client: qc },
        createElement(ToastContext.Provider, { value: toastCtx }, children),
      )
    }

    const { result } = renderHook(() => useUpdateCheck(), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.data?.updateAvailable).toBe(true))
    await waitFor(() => expect(toastCtx.info).toHaveBeenCalledTimes(1))

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['version'] })
    })
    await waitFor(() => expect(result.current.data?.updateAvailable).toBe(false))
    expect(toastCtx.info).toHaveBeenCalledTimes(1)

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['version'] })
    })
    await waitFor(() => expect(result.current.data?.updateAvailable).toBe(true))
    await waitFor(() => expect(toastCtx.info).toHaveBeenCalledTimes(2))
  })
})

// ---------------------------------------------------------------------------
// 7. getStaticVersion — DOM meta tag reader
// ---------------------------------------------------------------------------

describe('getStaticVersion', () => {
  it('returns the content of meta[name="fleet-version"] when present', async () => {
    const mockMeta = { content: 'v1.2.3-abc1234' }
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue(mockMeta),
    })

    const { getStaticVersion } = await import('../../console/src/hooks/use-update-check.js')
    expect(getStaticVersion()).toBe('v1.2.3-abc1234')
  })

  it('returns "unknown" when the meta tag is absent (querySelector returns null)', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue(null),
    })

    const { getStaticVersion } = await import('../../console/src/hooks/use-update-check.js')
    expect(getStaticVersion()).toBe('unknown')
  })

  it('returns "unknown" when meta.content is empty string (falsy fallback)', async () => {
    // Source: meta?.content || 'unknown' — empty string is falsy → 'unknown'
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue({ content: '' }),
    })

    const { getStaticVersion } = await import('../../console/src/hooks/use-update-check.js')
    expect(getStaticVersion()).toBe('unknown')
  })

  it('queries exactly the selector meta[name="fleet-version"]', async () => {
    const querySelectorMock = vi.fn().mockReturnValue(null)
    vi.stubGlobal('document', { querySelector: querySelectorMock })

    const { getStaticVersion } = await import('../../console/src/hooks/use-update-check.js')
    getStaticVersion()

    expect(querySelectorMock).toHaveBeenCalledWith('meta[name="fleet-version"]')
  })

  it('returns a non-empty string for any populated content', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue({ content: 'sha-feedcafe' }),
    })

    const { getStaticVersion } = await import('../../console/src/hooks/use-update-check.js')
    const version = getStaticVersion()
    expect(version.length).toBeGreaterThan(0)
    expect(version).not.toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// 8. Module exports shape
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports useUpdateCheck and getStaticVersion as functions', async () => {
    const mod = await import('../../console/src/hooks/use-update-check.js')
    expect(typeof mod.useUpdateCheck).toBe('function')
    expect(typeof mod.getStaticVersion).toBe('function')
  })

  it('exports at least the two expected runtime symbols', async () => {
    const mod = await import('../../console/src/hooks/use-update-check.js')
    const exported = Object.keys(mod)
    expect(exported).toContain('useUpdateCheck')
    expect(exported).toContain('getStaticVersion')
  })
})

// ---------------------------------------------------------------------------
// 9. Query configuration
// ---------------------------------------------------------------------------

describe('query configuration', () => {
  it('registers the version query with hourly polling and refetch-on-mount enabled', async () => {
    const { api } = await import('../../console/src/lib/api')
    ;(api.getVersion as Mock).mockReturnValue(new Promise(() => {}))

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper, qc } = makeWrapper(makeToastContext())

    renderHook(() => useUpdateCheck(), { wrapper })

    const query = qc.getQueryCache().getAll()[0]
    const queryOptions = query?.options as { refetchInterval?: unknown; refetchOnMount?: unknown } | undefined
    expect(query?.queryKey).toEqual(['version'])
    expect(queryOptions?.refetchInterval).toBe(3_600_000)
    expect(queryOptions?.refetchOnMount).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. UpdateState interface shape
// ---------------------------------------------------------------------------

describe('UpdateState interface', () => {
  it('has the four fields: sha, remoteSha, updateAvailable, checkedAt', async () => {
    const { api } = await import('../../console/src/lib/api')
    const mockData = makeUpdateState(true)
    ;(api.getVersion as Mock).mockResolvedValueOnce(mockData)

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())

    const data = result.current.data!
    expect(typeof data.sha).toBe('string')
    expect(typeof data.remoteSha).toBe('string')
    expect(typeof data.updateAvailable).toBe('boolean')
    expect(typeof data.checkedAt).toBe('string')
  })

  it('checkedAt is an ISO 8601 timestamp string', async () => {
    const { api } = await import('../../console/src/lib/api')
    const mockData = makeUpdateState(false)
    ;(api.getVersion as Mock).mockResolvedValueOnce(mockData)

    const { useUpdateCheck } = await import('../../console/src/hooks/use-update-check.js')
    const { wrapper } = makeWrapper(makeToastContext())

    const { result } = renderHook(() => useUpdateCheck(), { wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())

    expect(result.current.data?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})
