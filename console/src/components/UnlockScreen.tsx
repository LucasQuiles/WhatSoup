import { useState, useCallback, useId, useRef, type FormEvent } from 'react'
import { unlockConsole } from '../lib/api'
import { Button, TextInput } from './primitives'
import type { ConsoleSessionNotice } from '../hooks/use-console-session'

/**
 * B1 closure: the console starts locked in production. The operator enters
 * the root fleet token once; the server answers with an HttpOnly session
 * cookie and the token never persists in the browser.
 */
export default function UnlockScreen({ onUnlocked, notice = null, lockPersistenceError = false, onRetry }: {
  onUnlocked: () => void
  notice?: ConsoleSessionNotice
  lockPersistenceError?: boolean
  onRetry?: () => void | Promise<void>
}) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pendingAction = useRef(false)
  const errorId = useId()
  const revoking = notice === 'revocation_pending'

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim() || pendingAction.current || revoking) return
    pendingAction.current = true
    setBusy(true)
    setError(null)
    try {
      await unlockConsole(token.trim())
      setToken('')
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unlock failed')
    } finally {
      pendingAction.current = false
      setBusy(false)
    }
  }, [token, revoking, onUnlocked])

  const retry = useCallback(async () => {
    if (pendingAction.current || revoking || !onRetry) return
    pendingAction.current = true
    try { await onRetry() }
    finally { pendingAction.current = false }
  }, [revoking, onRetry])

  return (
    <div className="min-h-dvh flex items-center justify-center bg-surface-base px-[var(--sp-4)]">
      <form
        onSubmit={submit}
        className="flex w-full max-w-[var(--panel-shortcuts)] flex-col gap-[var(--sp-3)] rounded-[var(--radius-md)] border border-border-subtle bg-surface-raised p-[var(--sp-8)]"
      >
        <h1 className="c-heading">Console locked</h1>
        <p className="c-body text-text-2">
          Enter the fleet token to start a console session. The token is sent
          once to this server and is not stored in the browser.
        </p>
        {notice && <div role={revoking ? 'status' : 'alert'} className="c-body text-text-2">
          {revoking ? 'Local access is closed. Revoking server session…'
            : notice === 'revocation_unconfirmed'
              ? 'Local access is closed. Server session revocation could not be confirmed.'
              : notice === 'lock_storage_unavailable'
                ? 'This browser could not clear the stored lock request. Local access remains closed.'
                : 'Session status could not be checked. Local access remains closed.'}
          {(revoking || notice === 'revocation_unconfirmed') && lockPersistenceError
            && ' This browser could not retain the lock request. Reload may reopen the session before revocation succeeds.'}
        </div>}
        {notice && !revoking && onRetry && <Button type="button" variant="ghost" disabled={busy} onClick={retry}>
          {notice === 'revocation_unconfirmed' ? 'Retry lock'
            : notice === 'lock_storage_unavailable' ? 'Retry browser storage' : 'Retry session check'}
        </Button>}
        <TextInput
          type="password"
          autoFocus
          value={token}
          disabled={revoking}
          onChange={(e) => setToken(e.target.value)}
          placeholder="fleet token"
          aria-label="fleet token"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          error={Boolean(error)}
        />
        {error && <div id={errorId} role="alert" className="c-error">{error}</div>}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || revoking || !token.trim()}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </div>
  )
}
