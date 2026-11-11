/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Ceremony } from '../../console/src/components/journey/Ceremony'
import { api } from '../../console/src/lib/api'

const { navigate, success, error } = vi.hoisted(() => ({ navigate: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('react-router', () => ({ useNavigate: () => navigate }))
vi.mock('../../console/src/hooks/toast-context', () => ({ useToast: () => ({ success, error }) }))
vi.mock('../../console/src/lib/api', () => ({ api: { sendMessage: vi.fn() } }))

function setup() {
  const onAdjust = vi.fn()
  const view = render(<Ceremony name="Quinn" soul="Helpful" channelLabel="WhatsApp" adminPhone="+15550100001"
    lineName="quinn" agentInitial="Q" onAdjust={onAdjust} />)
  const input = view.getByRole('textbox', { name: 'First message (optional)' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'Hello' } })
  return { ...view, input, onAdjust }
}

beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('first-message delivery ownership', () => {
  it.each(['Enter', 'click'])('leaves an empty optional message unsent on %s', async (action) => {
    const view = setup()
    fireEvent.change(view.input, { target: { value: '   ' } })
    await act(async () => {
      if (action === 'Enter') fireEvent.keyDown(view.input, { key: 'Enter' })
      else fireEvent.click(view.getByRole('button', { name: 'Send & go live' }))
    })
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/')
    expect(success).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
  it('preserves an uncertain draft without retrying the send or claiming success', async () => {
    vi.useFakeTimers()
    vi.mocked(api.sendMessage).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ sent: true })
    const view = setup()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Send & go live' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(success).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(view.input.value).toBe('Hello')
    expect(view.getByRole('status').textContent).toMatch(/not confirmed/i)
    fireEvent.keyDown(view.input, { key: 'Enter' })
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: 'Check Inbox' }))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/inbox')
  })

  it('admits one attempt across repeated Enter events and disables conflicting actions', async () => {
    let finish!: (value: { sent: boolean }) => void
    vi.mocked(api.sendMessage).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const view = setup()
    act(() => {
      fireEvent.keyDown(view.input, { key: 'Enter' })
      fireEvent.keyDown(view.input, { key: 'Enter' })
      fireEvent.click(view.getByRole('button', { name: /Sending|Send & go live/ }))
    })
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect((view.getByRole('button', { name: 'Skip ceremony' }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: 'Adjust persona' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finish({ sent: true }) })
    expect(success).toHaveBeenCalledExactlyOnceWith('Quinn is live — first message sent to your admin')
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/')
    act(() => {
      fireEvent.keyDown(view.input, { key: 'Enter' })
      fireEvent.click(view.getByRole('button', { name: /Sending|Send & go live/ }))
    })
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'])('does not navigate or announce a late %s after unmount', async (outcome) => {
    vi.useFakeTimers()
    let finish!: (value: { sent: boolean }) => void
    let fail!: (reason: Error) => void
    vi.mocked(api.sendMessage).mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Send & go live' }))
    view.unmount()
    await act(async () => { if (outcome === 'resolve') finish({ sent: true }); else fail(new Error('response lost')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
