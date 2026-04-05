import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('console api mock-data loading', () => {
  it('does not import mock-data when api module loads', async () => {
    vi.doMock('../../console/src/mock-data.ts', () => {
      throw new Error('mock-data imported eagerly')
    })

    const module = await import('../../console/src/lib/api.ts')

    expect(module.api).toBeDefined()
  })

  it('imports mock-data only when the fallback path is used', async () => {
    vi.doMock('../../console/src/mock-data.ts', () => ({
      getLines: () => [{ name: 'mock-line' }],
      getLine: () => ({ name: 'mock-line' }),
      getChats: () => [],
      getMessages: () => [],
      getAccess: () => [],
      getLogs: () => [],
      getFeed: () => [],
    }))

    vi.stubGlobal('document', {
      querySelector: () => null,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.getLines()).resolves.toEqual([{ name: 'mock-line' }])
  })
})
