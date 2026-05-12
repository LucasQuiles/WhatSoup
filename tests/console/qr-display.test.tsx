/**
 * QrDisplay — canvas-rendered QR code with theme-driven color tokens.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const toCanvasMock = vi.fn()

vi.mock('qrcode', () => ({
  default: { toCanvas: toCanvasMock },
  toCanvas: toCanvasMock,
}))

// Import after mock so the component picks up the mocked module.
const { default: QrDisplay } = await import('../../console/src/components/QrDisplay')

afterEach(() => {
  cleanup()
  toCanvasMock.mockClear()
})

function stubThemeTokens(dark: string, light: string): void {
  const original = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element, pseudoElt?: string | null) => {
    if (elt === document.documentElement) {
      return {
        getPropertyValue: (name: string) => {
          if (name === '--color-t1') return dark
          if (name === '--color-d1') return light
          return ''
        },
      } as unknown as CSSStyleDeclaration
    }
    return original(elt, pseudoElt ?? undefined)
  })
}

describe('QrDisplay', () => {
  it('renders a canvas element with the rounded-md class', () => {
    stubThemeTokens('#111111', '#eeeeee')
    const { container } = render(<QrDisplay value="hello" />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.tagName).toBe('CANVAS')
    expect(canvas?.className).toBe('rounded-md')
  })

  it('invokes qrcode.toCanvas on mount with canvas, value, and option shape including default size 256', () => {
    stubThemeTokens('#111111', '#eeeeee')
    const { container } = render(<QrDisplay value="payload-1" />)
    const canvas = container.querySelector('canvas')
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
    const [calledCanvas, calledValue, calledOpts] = toCanvasMock.mock.calls[0]
    expect(calledCanvas).toBe(canvas)
    expect(calledValue).toBe('payload-1')
    expect(calledOpts).toEqual({
      width: 256,
      margin: 2,
      color: { dark: '#111111', light: '#eeeeee' },
    })
  })

  it('passes the explicit size prop through as the option width', () => {
    stubThemeTokens('#222222', '#dddddd')
    render(<QrDisplay value="sized" size={128} />)
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
    const opts = toCanvasMock.mock.calls[0][2]
    expect(opts.width).toBe(128)
    expect(opts.margin).toBe(2)
    expect(opts.color).toEqual({ dark: '#222222', light: '#dddddd' })
  })

  it('re-invokes toCanvas when the value prop changes between renders', () => {
    stubThemeTokens('#000000', '#ffffff')
    const { rerender } = render(<QrDisplay value="first" />)
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
    expect(toCanvasMock.mock.calls[0][1]).toBe('first')

    rerender(<QrDisplay value="second" />)
    expect(toCanvasMock).toHaveBeenCalledTimes(2)
    expect(toCanvasMock.mock.calls[1][1]).toBe('second')
  })

  it('re-invokes toCanvas when only the size prop changes', () => {
    stubThemeTokens('#000000', '#ffffff')
    const { rerender } = render(<QrDisplay value="stable" size={256} />)
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
    expect(toCanvasMock.mock.calls[0][2].width).toBe(256)

    rerender(<QrDisplay value="stable" size={384} />)
    expect(toCanvasMock).toHaveBeenCalledTimes(2)
    expect(toCanvasMock.mock.calls[1][2].width).toBe(384)
  })

  it('skips toCanvas when value is an empty string (effect guards on truthy value)', () => {
    stubThemeTokens('#000000', '#ffffff')
    render(<QrDisplay value="" />)
    expect(toCanvasMock).not.toHaveBeenCalled()
  })

  it('trims whitespace from CSS custom property values before passing to qrcode', () => {
    // Real getPropertyValue returns the declared value verbatim; component calls .trim()
    // to defend against the trailing space some browsers emit. Stub raw values that
    // include outer whitespace and verify the trimmed form reaches qrcode.
    stubThemeTokens('  #abcdef  ', '\t#fedcba\n')
    render(<QrDisplay value="trim-me" />)
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
    const opts = toCanvasMock.mock.calls[0][2]
    expect(opts.color).toEqual({ dark: '#abcdef', light: '#fedcba' })
  })

  it('unmounts cleanly without invoking toCanvas an additional time', () => {
    stubThemeTokens('#000000', '#ffffff')
    const { unmount } = render(<QrDisplay value="bye" />)
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
    expect(() => unmount()).not.toThrow()
    expect(toCanvasMock).toHaveBeenCalledTimes(1)
  })
})
