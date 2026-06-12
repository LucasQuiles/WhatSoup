import { useState, useCallback, type FormEvent } from 'react'
import { unlockConsole } from '../lib/api'

/**
 * B1 closure: the console starts locked in production. The operator enters
 * the root fleet token once; the server answers with an HttpOnly session
 * cookie and the token never persists in the browser.
 */
export default function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    <div className="min-h-screen flex items-center justify-center bg-b1">
      <form onSubmit={submit} className="flex flex-col gap-3 p-8 rounded border border-b3 bg-b2 w-96">
        <h1 className="text-t1 font-semibold text-lg">Console locked</h1>
        <p className="text-t3 text-sm">
          Enter the fleet token to start a console session. The token is sent
          once to this server and is not stored in the browser.
        </p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="fleet token"
          aria-label="fleet token"
          className="font-mono text-sm p-2 rounded border border-b3 bg-b1 text-t1"
        />
        {error && <div role="alert" className="text-err text-sm">{error}</div>}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="p-2 rounded bg-accent text-b1 font-semibold disabled:opacity-50"
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
