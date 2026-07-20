import { useState, useCallback, useId, type FormEvent } from 'react'
import { unlockConsole } from '../lib/api'
import { Button, TextInput } from './primitives'

/**
 * B1 closure: the console starts locked in production. The operator enters
 * the root fleet token once; the server answers with an HttpOnly session
 * cookie and the token never persists in the browser.
 */
export default function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const errorId = useId()

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await unlockConsole(token.trim())
      setToken('')
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unlock failed')
    } finally {
      setBusy(false)
    }
  }, [token, busy, onUnlocked])

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
        <TextInput
          type="password"
          autoFocus
          value={token}
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
          disabled={busy || !token.trim()}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </div>
  )
}
