import { useCallback, useEffect, useState } from 'react'
import { getApiTicket, isProductionConsole, lockConsole } from '../lib/api'

export type ConsoleSessionState = 'checking' | 'locked' | 'unlocked' | 'dev'

/**
 * Console session gate (B1 closure). In production the console starts
 * locked; we probe by minting a ticket against the session cookie. In dev
 * (no fleet-auth-mode meta) the Vite proxy owns auth and the gate is open.
 */
export function useConsoleSession(): {
  state: ConsoleSessionState
  onUnlocked: () => void
  onLock: () => Promise<void>
} {
  const [state, setState] = useState<ConsoleSessionState>(
    isProductionConsole() ? 'checking' : 'dev',
  )

  useEffect(() => {
    if (state !== 'checking') return
    let cancelled = false
    void (async () => {
      try {
        await getApiTicket('api')
        if (!cancelled) setState('unlocked')
      } catch {
        if (cancelled) return
        // 401 and network errors both map to locked (deliberate): the unlock
        // screen is the retry surface either way.
        setState('locked')
      }
    })()
    return () => { cancelled = true }
  }, [state])

  const onUnlocked = useCallback(() => setState('unlocked'), [])

  // Logout: revoke the server session, then relock the gate so the
  // UnlockScreen is shown again. Best-effort — relock even if the network
  // call fails so the operator is never stuck "logged in" locally.
  const onLock = useCallback(async () => {
    // Best-effort revoke; never reject to the click handler. Relock the gate
    // regardless so the operator is never stuck "logged in" locally.
    try {
      await lockConsole()
    } catch {
      // network/server error — local relock below is the safe fallback
    }
    setState('locked')
  }, [])

  return { state, onUnlocked, onLock }
}
