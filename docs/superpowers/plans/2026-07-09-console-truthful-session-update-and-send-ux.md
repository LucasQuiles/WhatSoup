# Console Truthful Session, Update, and Send UX Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make update, authentication, delivery, loading, error, empty, and polling states truthful while preserving operator recovery material.

**Architecture:** One session provider owns lock state, protected query data, and realtime lifetime. A pure restart-proof reducer gates update completion, while one send hook/component pair gives Inbox and History the same stable-id recovery behavior.

**Tech Stack:** React 19, TypeScript 5.9, TanStack Query 5, Vitest 4, Vitest Browser with Playwright.

## Global Constraints

- Audited base: `7330bafbe77d7a15febce32eb09b304e8778862f` (`origin/main`).
- Publication boundary: Local branch and commits only. Publishing branches or Draft PRs still requires explicit approval.
- This is a remediation program, not a license for a broad rewrite.
- Failed message sends preserve the draft or a failed bubble.
- Retrying a possibly delivered message is gated by defined idempotency semantics and honest copy.
- Load failures render retryable error states rather than empty data.
- WS-B05 must be based on WS-A05; do not emulate transport idempotency in the browser.
- Add no runtime dependency; use `scripts/run-with-pinned-npm.sh` for every command.

---

## File Structure

- `console/src/lib/update-restart-proof.ts` owns pure update proof.
- `console/src/lib/console-session-events.ts` and `console/src/hooks/use-console-session.tsx` own expiry.
- `console/src/hooks/use-message-send.ts` and `console/src/components/MessageComposer.tsx` own shared send UX.
- `Inbox.tsx`, `LineDetail.tsx`, and `HistoryTab.tsx` only compose these contracts and query states.

### Task 1: Require Positive Restart Proof

**Files:**
- Create: `console/src/lib/update-restart-proof.ts`
- Modify: `console/src/components/UpdateModal.tsx:72-335`
- Test: `tests/console/update-modal.test.tsx`
- Test: `tests/console/update-modal-sse-error.test.tsx`

**Interfaces:**
- Produces `RestartProof` and `restartIsProven(proof, observedSha, currentSha): boolean`.
- A restart is terminal only after `restart:running` plus either the expected changed SHA or an observed down/up cycle.

- [ ] **Step 1: Write the failing proof tests**

Create `tests/console/update-restart-proof.test.ts`:

~~~ts
import { describe, expect, it } from 'vitest'
import {
  initialRestartProof,
  reduceRestartProof,
  restartIsProven,
} from '../../console/src/lib/update-restart-proof.ts'

describe('restart proof', () => {
  it('rejects changed SHA before restart:running', () => {
    const proof = reduceRestartProof(initialRestartProof(), {
      type: 'pull', newSha: 'def5678', noChanges: false,
    })
    expect(restartIsProven(proof, 'def5678', 'abc1234')).toBe(false)
  })

  it('accepts expected changed SHA after restart:running', () => {
    let proof = reduceRestartProof(initialRestartProof(), {
      type: 'pull', newSha: 'def5678', noChanges: false,
    })
    proof = reduceRestartProof(proof, { type: 'restart-started' })
    expect(restartIsProven(proof, 'def5678', 'abc1234')).toBe(true)
  })

  it('requires down/up proof for unchanged SHA', () => {
    let proof = reduceRestartProof(initialRestartProof(), {
      type: 'pull', newSha: 'abc1234', noChanges: true,
    })
    proof = reduceRestartProof(proof, { type: 'restart-started' })
    expect(restartIsProven(proof, 'abc1234', 'abc1234')).toBe(false)
    proof = reduceRestartProof(proof, { type: 'fleet-down' })
    expect(restartIsProven(proof, 'abc1234', 'abc1234')).toBe(true)
  })
})
~~~

- [ ] **Step 2: Confirm the red test**

Run:

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/update-restart-proof.test.ts --pool=forks
~~~

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the proof helper**

Create `console/src/lib/update-restart-proof.ts`:

~~~ts
export interface RestartProof {
  restartEventSeen: boolean
  expectedSha: string | null
  noChanges: boolean
  seenDown: boolean
}

export type RestartProofEvent =
  | { type: 'pull'; newSha: string | null; noChanges: boolean }
  | { type: 'restart-started' }
  | { type: 'fleet-down' }

export function initialRestartProof(): RestartProof {
  return {
    restartEventSeen: false,
    expectedSha: null,
    noChanges: false,
    seenDown: false,
  }
}

export function reduceRestartProof(
  proof: RestartProof,
  event: RestartProofEvent,
): RestartProof {
  if (event.type === 'pull') {
    return { ...proof, expectedSha: event.newSha, noChanges: event.noChanges }
  }
  if (event.type === 'restart-started') {
    return { ...proof, restartEventSeen: true }
  }
  return { ...proof, seenDown: true }
}

export function restartIsProven(
  proof: RestartProof,
  observedSha: string,
  currentSha: string,
): boolean {
  if (!proof.restartEventSeen) return false
  if (
    proof.expectedSha
    && proof.expectedSha !== currentSha
    && observedSha === proof.expectedSha
  ) return true
  if (!proof.seenDown) return false
  return proof.expectedSha
    ? observedSha === proof.expectedSha
    : proof.noChanges && observedSha === currentSha
}
~~~

- [ ] **Step 4: Replace unsafe UpdateModal transitions**

Add `proofRef = useRef(initialRestartProof())`. Reset it in `startUpdate`. Parse `newSha` and `noChanges` from pull progress and record `restart-started` only for `step === 'restart' && status === 'running'`.

Replace `waitForFleetRestart` with:

~~~tsx
const waitForFleetRestart = useCallback(() => {
  if (pollRef.current || hasErroredRef.current) return
  if (!proofRef.current.restartEventSeen) {
    hasErroredRef.current = true
    dispatch({
      type: 'setError',
      message: 'Update stream ended before restart was confirmed.',
    })
    return
  }
  dispatch({ type: 'setPhase', phase: 'restarting-fleet' })
  const poll = setInterval(async () => {
    try {
      const version = await api.getVersion()
      if (!restartIsProven(proofRef.current, version.sha, currentSha)) return
      clearInterval(poll)
      pollRef.current = null
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = null
      void queryClient.invalidateQueries()
      dispatch({ type: 'setPhase', phase: 'restart-instances' })
    } catch {
      proofRef.current = reduceRestartProof(
        proofRef.current,
        { type: 'fleet-down' },
      )
    }
  }, pollIntervalMs)
  pollRef.current = poll
  timeoutRef.current = setTimeout(() => {
    clearInterval(poll)
    pollRef.current = null
    timeoutRef.current = null
    hasErroredRef.current = true
    dispatch({
      type: 'setError',
      message: 'Could not verify fleet restart. Check the service and version.',
    })
  }, fleetDownTimeoutMs)
}, [currentSha, fleetDownTimeoutMs, pollIntervalMs, queryClient])
~~~

Catch `JSON.parse` separately and dispatch `Update stream contained invalid data.`. Delete the existing timeout test that expects restart controls; replace it with a fake-clock test:

~~~tsx
it('keeps timeout in error, never Update Complete', async () => {
  vi.useFakeTimers()
  mockApiGetVersion.mockResolvedValue({ sha: 'abc1234' })
  render(
    <UpdateModal
      {...defaultProps()}
      pollIntervalMs={100}
      fleetDownTimeoutMs={500}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Update' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(screen.getByText(/Could not verify fleet restart/)).toBeDefined()
  expect(screen.queryByText('Update Complete')).toBeNull()
})
~~~

- [ ] **Step 5: Verify and commit this slice**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/update-restart-proof.test.ts tests/console/update-modal.test.tsx tests/console/update-modal-sse-error.test.tsx --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add console/src/lib/update-restart-proof.ts console/src/components/UpdateModal.tsx tests/console/update-restart-proof.test.ts tests/console/update-modal.test.tsx tests/console/update-modal-sse-error.test.tsx
git commit -m "fix(console): require restart proof for updates"
~~~

Expected: tests PASS; typecheck exits 0.

### Task 2: Preserve Drafts and Model Definite Versus Ambiguous Sends

**Files:**
- Create: `console/src/hooks/use-message-send.ts`
- Create: `console/src/components/MessageComposer.tsx`
- Modify: `console/src/types.ts:88-99`
- Modify: `console/src/lib/api.ts:375-379`
- Modify: `console/src/components/MessageBubble.tsx:1-161`
- Modify: `console/src/pages/Inbox.tsx:1-230,370-488`
- Modify: `console/src/components/line-detail/HistoryTab.tsx:1-230`
- Test: `tests/console/use-message-send.test.tsx`
- Test: `tests/browser/console-message-recovery.test.tsx`

**Interfaces:**
- Consumes this exact WS-A05 contract:

~~~ts
export type ConsoleSendResult =
  | { outcome: 'submitted'; messageId: string }
  | { outcome: 'maybe_sent'; messageId: string }

api.sendMessage(
  name: string,
  chatJid: string,
  text: string,
  options: { messageId: string },
): Promise<ConsoleSendResult>
~~~

- A rejected promise is a definite failure safe to retry with the same ID. `maybe_sent` disables one-click retry.

- [ ] **Step 1: Pin red send-state tests**

Create `tests/console/use-message-send.test.tsx` with a QueryClient wrapper and these assertions:

~~~tsx
it('keeps draft and failed bubble after definite failure', async () => {
  sendMessageMock.mockRejectedValue(new Error('transport rejected'))
  const { result, client } = renderSendHook(() => 'stable-id')
  act(() => result.current.setDraft('keep this text'))
  await act(async () => { await result.current.send() })
  expect(result.current.draft).toBe('keep this text')
  expect(client.getQueryData<Message[]>(['messages', 'alpha', 'chat-a']))
    .toEqual([expect.objectContaining({
      content: 'keep this text',
      clientMessageId: 'stable-id',
      deliveryState: 'failed',
    })])
})

it('reuses the same id and never retries maybe_sent', async () => {
  sendMessageMock
    .mockRejectedValueOnce(new Error('definite'))
    .mockResolvedValueOnce({ outcome: 'submitted', messageId: 'stable-id' })
  const { result, client } = renderSendHook(() => 'stable-id')
  act(() => result.current.setDraft('retry me'))
  await act(async () => { await result.current.send() })
  const failed = client.getQueryData<Message[]>(
    ['messages', 'alpha', 'chat-a'],
  )![0]
  await act(async () => { await result.current.retry(failed) })
  expect(sendMessageMock.mock.calls.map((call) => call[3])).toEqual([
    { messageId: 'stable-id' },
    { messageId: 'stable-id' },
  ])
})
~~~

`renderSendHook` creates local `draft` state, wraps `useMessageSend`, and returns the QueryClient. Run:

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/use-message-send.test.tsx --pool=forks
~~~

Expected: FAIL because the hook does not exist.

- [ ] **Step 2: Add local delivery fields**

Add to `Message`:

~~~ts
clientMessageId?: string
deliveryState?: 'sending' | 'submitted' | 'failed' | 'maybe_sent'
~~~

- [ ] **Step 3: Implement the shared send hook**

Create `console/src/hooks/use-message-send.ts`:

~~~ts
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Message } from '../types'

let nextPk = -1

export function useMessageSend(args: {
  lineName: string
  conversationKey: string
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  createMessageId?: () => string
  onFailure?: (message: string) => void
}) {
  const client = useQueryClient()
  const [isSending, setIsSending] = useState(false)
  const key = ['messages', args.lineName, args.conversationKey] as const
  const update = useCallback((
    id: string,
    change: (message: Message) => Message | null,
  ) => {
    client.setQueryData<Message[]>(key, (rows) =>
      (rows ?? []).flatMap((row) => {
        if (row.clientMessageId !== id) return [row]
        const changed = change(row)
        return changed ? [changed] : []
      }),
    )
  }, [client, key])
  const attempt = useCallback(async (id: string, text: string) => {
    setIsSending(true)
    update(id, (row) => ({ ...row, deliveryState: 'sending' }))
    try {
      const result = await api.sendMessage(
        args.lineName,
        args.conversationKey,
        text,
        { messageId: id },
      )
      if (result.outcome === 'maybe_sent') {
        update(id, (row) => ({ ...row, deliveryState: 'maybe_sent' }))
      } else {
        update(id, () => null)
        await client.invalidateQueries({ queryKey: key })
      }
      args.setDraft((current) => current.trim() === text ? '' : current)
    } catch (error) {
      update(id, (row) => ({ ...row, deliveryState: 'failed' }))
      args.onFailure?.(
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setIsSending(false)
    }
  }, [args, client, key, update])
  const send = useCallback(async () => {
    const text = args.draft.trim()
    if (!text || isSending || !args.conversationKey) return
    const id = (args.createMessageId ?? (() => crypto.randomUUID()))()
    const row: Message = {
      pk: nextPk--,
      conversationKey: args.conversationKey,
      senderName: 'You',
      senderJid: '',
      content: text,
      timestamp: new Date().toISOString(),
      fromMe: true,
      type: 'text',
      clientMessageId: id,
      deliveryState: 'sending',
    }
    client.setQueryData<Message[]>(key, (rows) => [row, ...(rows ?? [])])
    await attempt(id, text)
  }, [args, attempt, client, isSending, key])
  const retry = useCallback(async (row: Message) => {
    if (
      isSending
      || row.deliveryState !== 'failed'
      || !row.clientMessageId
      || !row.content
    ) return
    await attempt(row.clientMessageId, row.content)
  }, [attempt, isSending])
  return { isSending, send, retry }
}
~~~

- [ ] **Step 4: Share the composer and honest status copy**

Create `MessageComposer.tsx`:

~~~tsx
import { forwardRef } from 'react'
import { Loader2, Send } from 'lucide-react'
import { TextArea } from './primitives'
import { ActionButton } from './primitives/ActionButton'

interface MessageComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  isSending: boolean
  placeholder: string
  ariaLabel: string
}

export const MessageComposer = forwardRef<
  HTMLTextAreaElement,
  MessageComposerProps
>(function MessageComposer(props, ref) {
  return (
    <div className="flex items-center gap-[var(--sp-3)]">
      <TextArea
        ref={ref}
        rows={1}
        minHeight={0}
        maxHeight="var(--feed-preview-max)"
        resize="none"
        overflow="hidden"
        textFace="sans"
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            props.onSend()
          }
        }}
      />
      <ActionButton
        label={props.isSending ? 'Sending' : 'Send'}
        icon={props.isSending
          ? <Loader2 size={16} className="animate-spin" />
          : <Send size={16} />}
        onClick={props.onSend}
        disabled={props.isSending || !props.value.trim()}
      />
    </div>
  )
})
~~~

The input keeps `value` until the hook clears it after `submitted`/`maybe_sent`.

Replace `DeliveryStatus` in `MessageBubble`:

~~~tsx
if (msg.deliveryState === 'failed') {
  return (
    <span className="text-s-crit">
      Not sent
      {onRetry && msg.clientMessageId && (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Retry definite send failure"
          onClick={() => onRetry(msg)}
        >
          <RotateCw size={10} />
        </Button>
      )}
    </span>
  )
}
if (msg.deliveryState === 'maybe_sent') {
  return (
    <span
      className="text-s-warn"
      title="Delivery unconfirmed. Check the chat before sending again."
    >
      Delivery unconfirmed
    </span>
  )
}
if (msg.deliveryState === 'sending' || msg.pk < 0) {
  return <Check size={12} className="text-text-3" />
}
return <Check size={12} className="text-s-ok" />
~~~

Use the hook and composer in Inbox and History. Pass `onRetry={retry}` to bubbles. Remove both “clear draft on chat switch” effects.

- [ ] **Step 5: Add real-browser recovery proof**

Create `tests/browser/console-message-recovery.test.tsx`. Render a QueryClient harness using the actual hook, composer, and bubbles; mock first call rejected and second `submitted`. Use:

~~~tsx
await input.fill('keep this draft')
await screen.getByRole('button', { name: 'Send' }).click()
await expect.element(input).toHaveValue('keep this draft')
await screen
  .getByRole('button', { name: 'Retry definite send failure' })
  .click()
expect(sendMessage.mock.calls[0][3]).toEqual({ messageId: 'stable-browser-id' })
expect(sendMessage.mock.calls[1][3]).toEqual({ messageId: 'stable-browser-id' })
~~~

- [ ] **Step 6: Verify and commit this slice**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/use-message-send.test.tsx tests/console/inbox-page.test.tsx tests/console/history-tab.test.tsx tests/console/message-bubble-extended.test.tsx tests/console/api-operations.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run test:browser -- tests/browser/console-message-recovery.test.tsx
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add console/src/hooks/use-message-send.ts console/src/components/MessageComposer.tsx console/src/types.ts console/src/lib/api.ts console/src/components/MessageBubble.tsx console/src/pages/Inbox.tsx console/src/components/line-detail/HistoryTab.tsx tests/console/use-message-send.test.tsx tests/console/inbox-page.test.tsx tests/console/history-tab.test.tsx tests/console/message-bubble-extended.test.tsx tests/console/api-operations.test.ts tests/browser/console-message-recovery.test.tsx
git commit -m "fix(console): preserve failed message drafts"
~~~

Expected: focused tests PASS, one browser test passes, typecheck exits 0.

### Task 3: Distinguish Loading, Error, Empty, and Healthy Polling

**Files:**
- Modify: `console/src/hooks/use-transport-status.ts:1-100`
- Modify: `console/src/pages/Inbox.tsx:90-480`
- Modify: `console/src/pages/LineDetail.tsx:65-360`
- Modify: `console/src/components/line-detail/HistoryTab.tsx:1-303`
- Modify: `console/src/components/MessageBubble.tsx`
- Test: `tests/console/use-transport-status.test.ts`
- Test: `tests/console/inbox-page.test.tsx`
- Test: `tests/console/history-tab.test.tsx`

**Interfaces:**
- `TransportStatus = 'connected' | 'polling' | 'reconnecting' | 'offline'`.
- `polling` is healthy: `isDisconnected === false`.

- [ ] **Step 1: Add failing state tests**

~~~ts
it('reports healthy polling when development expects no websocket', () => {
  mockedIsProductionConsole.mockReturnValue(false)
  wsConnected = false
  const { result } = renderHook(() => useTransportStatus())
  expect(result.current.status).toBe('polling')
  expect(result.current.isDisconnected).toBe(false)
})
~~~

Add this Inbox pattern for both chats and messages, and the same assertions to `history-tab.test.tsx`:

~~~tsx
it('renders a retryable message error instead of empty copy', () => {
  mockChats = [makeChat('conv-a')]
  mockMessagesError = new Error('message database unavailable')
  renderInbox()
  fireEvent.click(screen.getByRole('option', {
    name: 'Open conversation with Chat conv-a',
  }))
  expect(screen.getByText('Failed to load messages')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Retry messages' }))
  expect(refetchMessagesMock).toHaveBeenCalledOnce()
  expect(screen.queryByText('No messages')).toBeNull()
})
~~~

- [ ] **Step 2: Implement transport truth**

~~~ts
function deriveStatus(
  browserOnline: boolean,
  socketConnected: boolean,
  production: boolean,
): TransportStatus {
  if (!browserOnline) return 'offline'
  if (socketConnected) return 'connected'
  return production ? 'reconnecting' : 'polling'
}
const isDisconnected = status === 'reconnecting' || status === 'offline'
~~~

- [ ] **Step 3: Render queries in strict state order**

Destructure `isLoading`, `error`, and `refetch` from chats/messages in Inbox and LineDetail. Render: loading → retryable error → empty → data. Offline-with-cache is allowed only when cached rows exist.

Thread these exact optional props into History:

~~~ts
chatsLoading?: boolean
chatsError?: Error | null
onRetryChats?: () => void
messagesLoading?: boolean
messagesError?: Error | null
onRetryMessages?: () => void
~~~

Remove `onCreateContact` from MessageBubble and History; it only displayed a toast and had no JID-save path. Keep Inbox's real `SaveContactDialog`.

- [ ] **Step 4: Verify and commit this slice**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/use-transport-status.test.ts tests/console/connection-banner.test.tsx tests/console/inbox-page.test.tsx tests/console/history-tab.test.tsx tests/console/message-bubble-extended.test.tsx --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add console/src/hooks/use-transport-status.ts console/src/pages/Inbox.tsx console/src/pages/LineDetail.tsx console/src/components/line-detail/HistoryTab.tsx console/src/components/MessageBubble.tsx tests/console/use-transport-status.test.ts tests/console/connection-banner.test.tsx tests/console/inbox-page.test.tsx tests/console/history-tab.test.tsx tests/console/message-bubble-extended.test.tsx
git commit -m "fix(console): distinguish unavailable and empty states"
~~~

Expected: tests PASS; typecheck exits 0.

### Task 4: Verify the Update, Send, and State Slices

**Files:** Verify only.

- [ ] **Step 1: Run complete console evidence**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/update-restart-proof.test.ts tests/console/update-modal.test.tsx tests/console/update-modal-sse-error.test.tsx tests/console/use-message-send.test.tsx tests/console/inbox-page.test.tsx tests/console/history-tab.test.tsx tests/console/message-bubble-extended.test.tsx tests/console/use-transport-status.test.ts tests/console/connection-banner.test.tsx --pool=forks
bash scripts/run-with-pinned-npm.sh run test:browser -- tests/browser/console-message-recovery.test.tsx
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh --prefix console run lint
bash scripts/run-with-pinned-npm.sh --prefix console run build
~~~

Expected: all commands exit 0 and browser reports one passing recovery test.

- [ ] **Step 2: Run the release gate**

~~~bash
bash scripts/run-with-pinned-npm.sh run verify:release
~~~

Expected: exit 0. Record missing browser/provider/live-service prerequisites as proof gaps; a masked run is not clean.

### Task 5: Make One Session Owner Relock Queries and Realtime

**Files:**
- Create: `console/src/lib/console-session-events.ts`
- Replace: `console/src/hooks/use-console-session.tsx`
- Modify: `console/src/lib/api.ts:65-180,555-566`
- Modify: `console/src/hooks/use-websocket.tsx:43-130`
- Modify: `console/src/main.tsx:1-31`
- Test: `tests/console/console-session-expiry.test.tsx`
- Test: `tests/console/use-websocket.test.tsx`

**Interfaces:**
- Produces `notifyConsoleSessionExpired` and `subscribeConsoleSessionExpired`.
- Produces `ConsoleSessionProvider`; it alone changes lock state and clears protected cache.

- [ ] **Step 1: Write the failing provider test**

Create `tests/console/console-session-expiry.test.tsx`:

~~~tsx
// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import {
  ConsoleSessionProvider,
  useConsoleSession,
} from '../../console/src/hooks/use-console-session'
import { notifyConsoleSessionExpired } from '../../console/src/lib/console-session-events'

vi.mock('../../console/src/lib/api', () => ({
  getApiTicket: vi.fn().mockResolvedValue('ticket'),
  lockConsole: vi.fn().mockResolvedValue(undefined),
  isProductionConsole: () => true,
}))

function Consumer() {
  const session = useConsoleSession()
  const client = useQueryClient()
  return (
    <>
      <span data-testid="state">{session.state}</span>
      <span data-testid="cache">
        {String(client.getQueryData(['lines']) ?? 'cleared')}
      </span>
    </>
  )
}

it('relocks once and clears protected data on repeated expiry signals', async () => {
  const client = new QueryClient()
  client.setQueryData(['lines'], 'private')
  const clear = vi.spyOn(client, 'clear')
  render(
    <QueryClientProvider client={client}>
      <ConsoleSessionProvider><Consumer /></ConsoleSessionProvider>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('unlocked'))
  act(() => {
    notifyConsoleSessionExpired()
    notifyConsoleSessionExpired()
  })
  expect(screen.getByTestId('state').textContent).toBe('locked')
  expect(screen.getByTestId('cache').textContent).toBe('cleared')
  expect(clear).toHaveBeenCalledOnce()
})
~~~

- [ ] **Step 2: Confirm the red test**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/console-session-expiry.test.tsx --pool=forks
~~~

Expected: FAIL because the event module/provider are absent.

- [ ] **Step 3: Add the event channel**

Create `console/src/lib/console-session-events.ts`:

~~~ts
type Listener = () => void
const listeners = new Set<Listener>()

export function notifyConsoleSessionExpired(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeConsoleSessionExpired(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
~~~

- [ ] **Step 4: Replace the hook with the session provider**

Use this state-changing core in `use-console-session.tsx`; retain the existing initial ticket probe and logout call around it:

~~~tsx
const ConsoleSessionContext = createContext<ConsoleSessionValue | null>(null)

export function ConsoleSessionProvider({ children }: { children: ReactNode }) {
  const production = isProductionConsole()
  const queryClient = useQueryClient()
  const locked = useRef(production)
  const [state, setState] = useState<ConsoleSessionState>(
    production ? 'checking' : 'dev',
  )
  const onExpired = useCallback(() => {
    if (!production || locked.current) return
    locked.current = true
    void queryClient.cancelQueries()
    queryClient.clear()
    setState('locked')
  }, [production, queryClient])
  useEffect(
    () => subscribeConsoleSessionExpired(onExpired),
    [onExpired],
  )
  useEffect(() => {
    if (state !== 'checking') return
    let cancelled = false
    void getApiTicket('api').then(
      () => {
        if (!cancelled) {
          locked.current = false
          setState('unlocked')
        }
      },
      () => {
        if (!cancelled) setState('locked')
      },
    )
    return () => { cancelled = true }
  }, [state])
  const onUnlocked = () => {
    locked.current = false
    setState(production ? 'unlocked' : 'dev')
  }
  const onLock = async () => {
    try { await lockConsole() } catch { /* local relock remains mandatory */ }
    locked.current = false
    onExpired()
  }
  return (
    <ConsoleSessionContext.Provider
      value={{ state, onUnlocked, onLock, onExpired }}
    >
      {children}
    </ConsoleSessionContext.Provider>
  )
}
~~~

Export `useConsoleSession` as a context reader that throws outside the provider.

- [ ] **Step 5: Classify all production 401s and gate the socket**

In `api.ts` add:

~~~ts
function throwConsoleLocked(): never {
  notifyConsoleSessionExpired()
  throw new ConsoleLockedError()
}
~~~

Call it for 401 in `mintTicket`, `apiFetch`, and `getWsTicket` before reading response text.

Wrap `RealtimeProvider` inside `ConsoleSessionProvider` in `main.tsx`. Make its effect depend on:

~~~ts
const { state } = useConsoleSession()
const sessionAllowsRealtime = state === 'unlocked' || state === 'dev'
~~~

If false, close `wsRef.current`, clear reconnect timeout, set disconnected, and return. A ticket 401 is not retried because the API notifier changes session state; ordinary network failures keep the current exponential backoff.

- [ ] **Step 6: Add socket teardown and API notifier tests**

In `use-websocket.test.tsx` render unlocked, open `FakeWebSocket`, change mocked session state to `locked`, rerender, and assert `readyState === CLOSED` and no later reconnect after advancing 30 seconds. In `api-ticket.test.ts` subscribe, return 401 from ticket mint, and assert `ConsoleLockedError` plus one listener call.

- [ ] **Step 7: Verify and commit this slice**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/console-session-expiry.test.tsx tests/console/use-console-session-lock.test.tsx tests/console/use-websocket.test.tsx tests/console/api-ticket.test.ts tests/console/app.test.tsx --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add console/src/lib/console-session-events.ts console/src/lib/api.ts console/src/hooks/use-console-session.tsx console/src/hooks/use-websocket.tsx console/src/main.tsx console/src/App.tsx tests/console/console-session-expiry.test.tsx tests/console/use-console-session-lock.test.tsx tests/console/use-websocket.test.tsx tests/console/api-ticket.test.ts
git commit -m "fix(console): relock expired sessions"
~~~

Expected: tests PASS; typecheck exits 0.

### Task 6: Full Verification

**Files:** Verify only.

- [ ] **Step 1: Run complete console evidence**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/update-restart-proof.test.ts tests/console/update-modal.test.tsx tests/console/update-modal-sse-error.test.tsx tests/console/console-session-expiry.test.tsx tests/console/use-console-session-lock.test.tsx tests/console/use-websocket.test.tsx tests/console/api-ticket.test.ts tests/console/use-message-send.test.tsx tests/console/inbox-page.test.tsx tests/console/history-tab.test.tsx tests/console/message-bubble-extended.test.tsx tests/console/use-transport-status.test.ts tests/console/connection-banner.test.tsx --pool=forks
bash scripts/run-with-pinned-npm.sh run test:browser -- tests/browser/console-message-recovery.test.tsx
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh --prefix console run lint
bash scripts/run-with-pinned-npm.sh --prefix console run build
bash scripts/run-with-pinned-npm.sh run verify:release
~~~

Expected: all commands exit 0. Record missing browser/provider/live-service prerequisites as proof gaps; a masked run is not clean.

## Self-Review Notes

- Coverage: Task 1 = WS-B03, Task 5 = WS-B04, Task 2 = WS-B05, Task 3 = WS-B06.
- Type consistency: stable-id `messageId`, `maybe_sent`, `RestartProof`, and History query props use one spelling.
- Browser/fake-clock proof: Task 1 tests timeout with fake timers; Task 2 tests recovery in Chromium.
- Residual uncertainty: the exact WS-A05 response must match this plan before Task 2 starts. A staged fleet restart and real ambiguous WhatsApp timeout remain deployment checks.
