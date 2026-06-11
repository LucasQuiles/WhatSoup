/**
 * @vitest-environment jsdom
 */
// Theme hook behavior: default, hydration from persisted preference, toggling,
// invalid stored values, and data-theme attribute application (tokens-v3 §5 mechanics).
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTheme } from '../../console/src/hooks/use-theme'

const THEME_STORAGE_KEY = 'whatsoup:theme'

// This jsdom setup does not provide window.localStorage; the repo convention is an
// in-memory fake (see preferences.test.ts). The hook reaches storage through the
// preferences helpers, which default to the global localStorage.
function makeStorageFake() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorageFake())
  document.documentElement.removeAttribute('data-theme')
})

describe('useTheme', () => {
  it('defaults to dark and applies data-theme on <html>', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('hydrates a persisted light preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('falls back to dark for invalid stored values', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'hotdog-stand')
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('toggleTheme flips theme, updates the attribute, and persists', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('pre-paint init script in index.html matches the hook contract', () => {
    // The inline script and the hook must agree on key name, default, and target attribute,
    // or the page flashes the wrong theme before hydration.
    const html = readIndexHtml()
    expect(html).toContain(THEME_STORAGE_KEY)
    expect(html).toContain('data-theme')
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
function readIndexHtml(): string {
  return readFileSync(resolve(import.meta.dirname, '../../console/index.html'), 'utf8')
}
