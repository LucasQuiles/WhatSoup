/**
 * @vitest-environment jsdom
 */
// Theme hook behavior: default, hydration from persisted preference, toggling,
// invalid stored values, and data-theme attribute application (tokens-v3 §5 mechanics).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTheme } from '../../console/src/hooks/use-theme'

const THEME_STORAGE_KEY = 'whatsoup:theme'
const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]'
const THEME_COLOR_TOKEN = '--surface-base'

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
  document.head.querySelectorAll(THEME_COLOR_META_SELECTOR).forEach(meta => meta.remove())
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('setTheme pins the requested theme (T5 b-09 swatches) and sanitizes input', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme('light'))
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    act(() => result.current.setTheme('dark'))
    expect(result.current.theme).toBe('dark')

    // the hook's input law holds at the new seam too: anything not 'light' is dark
    act(() => result.current.setTheme('solarized' as never))
    expect(result.current.theme).toBe('dark')
  })

  it('updates theme-color meta to the current surface-base token', () => {
    const colors = readSurfaceBaseTokens()
    stubSurfaceBaseTokens(colors)
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', 'stale')
    document.head.append(meta)

    const { result } = renderHook(() => useTheme())
    expect(meta.getAttribute('content')).toBe(colors.dark)

    act(() => result.current.toggleTheme())
    expect(meta.getAttribute('content')).toBe(colors.light)

    act(() => result.current.toggleTheme())
    expect(meta.getAttribute('content')).toBe(colors.dark)
  })

  it('pre-paint init script in index.html matches the hook contract', () => {
    // The inline script and the hook must agree on key name, default, and target attribute,
    // or the page flashes the wrong theme before hydration.
    const html = readIndexHtml()
    const colors = readSurfaceBaseTokens()
    const initialThemeColor = readInitialThemeColor(html)

    expect(html).toContain(THEME_STORAGE_KEY)
    expect(html).toContain('data-theme')
    expect(initialThemeColor).toBe(colors.dark)
    expect(html).toContain('meta[name="theme-color"]')
    expect(html).toContain(`? '${colors.light}' : '${colors.dark}'`)
  })
})

const repoRoot = resolve(import.meta.dirname, '../..')
function readIndexHtml(): string {
  return readFileSync(resolve(repoRoot, 'console/index.html'), 'utf8')
}

function readInitialThemeColor(html: string): string | undefined {
  return /<meta\s+name="theme-color"\s+content="([^"]+)"\s*\/?>/.exec(html)?.[1]
}

function readSurfaceBaseTokens(): { dark: string; light: string } {
  const css = readFileSync(resolve(repoRoot, 'console/src/styles/tokens.semantic.css'), 'utf8')
  return {
    dark: extractSurfaceBase(css, /:root,\s*\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/),
    light: extractSurfaceBase(css, /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/),
  }
}

function extractSurfaceBase(css: string, scope: RegExp): string {
  const body = scope.exec(css)?.[1]
  const value = body ? /--surface-base:\s*(#[0-9A-Fa-f]{6});/.exec(body)?.[1] : undefined
  if (!value) throw new Error('Unable to find --surface-base in theme scope')
  return value
}

function stubSurfaceBaseTokens(colors: { dark: string; light: string }): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    getPropertyValue: (name: string) => (
      name === THEME_COLOR_TOKEN
        ? colors[document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark']
        : ''
    ),
  }) as CSSStyleDeclaration)
}
