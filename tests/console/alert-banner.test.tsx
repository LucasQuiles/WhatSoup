/**
 * AlertBanner behavior coverage.
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import AlertBanner from '../../console/src/components/AlertBanner'

interface Alert {
  line: string
  message: string
}

afterEach(() => {
  cleanup()
})

function renderAlertBanner(alerts: Alert[], onAlertClick?: (alert: Alert) => void) {
  return render(<AlertBanner alerts={alerts} onAlertClick={onAlertClick} />)
}

describe('AlertBanner empty state', () => {
  it('renders no alert chrome when alerts is empty', () => {
    const { container } = renderAlertBanner([])

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText(/alert/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('AlertBanner badge text', () => {
  it('renders the singular alert count', () => {
    renderAlertBanner([{ line: 'L1', message: 'connection-lost' }])

    expect(screen.getByText('1 alert')).toBeVisible()
    expect(screen.queryByText('1 alerts')).not.toBeInTheDocument()
  })

  it('renders the plural alert count', () => {
    renderAlertBanner([
      { line: 'L1', message: 'connection-lost' },
      { line: 'L2', message: 'rate-limited' },
      { line: 'L3', message: 'qr-expired' },
    ])

    expect(screen.getByText('3 alerts')).toBeVisible()
  })
})

describe('AlertBanner alert chips', () => {
  it('renders visible alert text in the banner surface', () => {
    const { container } = renderAlertBanner([
      { line: 'whatsoup@a', message: 'connection-lost' },
      { line: 'whatsoup@b', message: 'rate-limited' },
    ])

    const semanticSurface = screen.queryByRole('alert') ?? screen.queryByRole('banner')
    expect(semanticSurface ?? container.firstElementChild).toBeVisible()
    expect(screen.getByText('whatsoup@a')).toBeVisible()
    expect(screen.getByText('connection-lost')).toBeVisible()
    expect(screen.getByText('whatsoup@b')).toBeVisible()
    expect(screen.getByText('rate-limited')).toBeVisible()
  })

  it('renders one accessible type=button chip per alert', () => {
    renderAlertBanner([
      { line: 'L1', message: 'connection-lost' },
      { line: 'L2', message: 'rate-limited' },
    ])

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveAttribute('type', 'button')
    expect(buttons[1]).toHaveAttribute('type', 'button')

    expect(screen.getByRole('button', { name: /L1.*connection-lost/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /L2.*rate-limited/ })).toBeVisible()
  })

  it('keeps line and message text inside each alert button', () => {
    renderAlertBanner([{ line: 'line-alpha', message: 'needs-attention' }])

    const button = screen.getByRole('button', { name: /line-alpha.*needs-attention/ })
    expect(within(button).getByText('line-alpha')).toBeVisible()
    expect(within(button).getByText('needs-attention')).toBeVisible()
  })

  it('forwards the clicked alert to onAlertClick', () => {
    const onAlertClick = vi.fn()
    const alert = { line: 'L1', message: 'connection-lost' }
    renderAlertBanner([alert], onAlertClick)

    fireEvent.click(screen.getByRole('button', { name: /L1.*connection-lost/ }))

    expect(onAlertClick).toHaveBeenCalledTimes(1)
    expect(onAlertClick).toHaveBeenCalledWith(alert)
  })

  it('does not throw when an alert is clicked without onAlertClick', () => {
    renderAlertBanner([{ line: 'L1', message: 'connection-lost' }])

    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: /L1.*connection-lost/ }))
    }).not.toThrow()
  })
})
