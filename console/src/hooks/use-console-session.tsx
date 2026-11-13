import { useCallback, useEffect, useRef, useState } from 'react'
import { ConsoleLockedError, getApiTicket, isProductionConsole, lockConsole } from '../lib/api'

export type ConsoleSessionState = 'checking' | 'locked' | 'unlocked' | 'dev'
export type ConsoleSessionNotice = 'session_unavailable' | 'revocation_pending' | 'revocation_unconfirmed' | 'lock_storage_unavailable' | null

const LOCK_REQUESTED_KEY = 'whatsoup.console.lock-requested'

function hasPendingLock(): boolean {
  try { return sessionStorage.getItem(LOCK_REQUESTED_KEY) === '1' }
  catch { return true }
}

function rememberLock(requested: boolean): boolean {
  try {
    if (requested) sessionStorage.setItem(LOCK_REQUESTED_KEY, '1')
    else sessionStorage.removeItem(LOCK_REQUESTED_KEY)
    return true
  } catch { return false }
}

/**
 * Console session gate (B1 closure). In production the console starts
 * locked; we probe by minting a ticket against the session cookie. In dev
 * (no fleet-auth-mode meta) the Vite proxy owns auth and the gate is open.
 */
export function useConsoleSession(): {
  state: ConsoleSessionState
  notice: ConsoleSessionNotice
  lockPersistenceError: boolean
  onUnlocked: () => void
  onLock: () => Promise<void>
  onRetry: () => Promise<void>
} {
  const [initial] = useState<{ state: ConsoleSessionState; notice: ConsoleSessionNotice }>(() => {
    if (!isProductionConsole()) return { state: 'dev', notice: null }
    return hasPendingLock()
      ? { state: 'locked', notice: 'revocation_unconfirmed' }
      : { state: 'checking', notice: null }
  })
  const [session, setSession] = useState(initial)
  const [lockPersistenceError, setLockPersistenceError] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const pendingLock = useRef<Promise<void> | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current += 1 }
  }, [])

  const probe = useCallback(() => {
    const current = ++generation.current
    return getApiTicket('api').then(() => {
      if (mounted.current && generation.current === current) setSession({ state: 'unlocked', notice: null })
    }, (error: unknown) => {
      if (mounted.current && generation.current === current) {
        setSession({ state: 'locked', notice: error instanceof ConsoleLockedError ? null : 'session_unavailable' })
      }
    })
  }, [])

  useEffect(() => {
    if (initial.state === 'checking') void probe()
  }, [initial.state, probe])

  const onUnlocked = useCallback(() => {
    if (!mounted.current || pendingLock.current) return
    generation.current += 1
    setSession(rememberLock(false)
      ? { state: 'unlocked', notice: null }
      : { state: 'locked', notice: 'lock_storage_unavailable' })
  }, [])

  const onLock = useCallback(() => {
    if (pendingLock.current) return pendingLock.current
    const current = ++generation.current
    setLockPersistenceError(!rememberLock(true))
    setSession({ state: 'locked', notice: 'revocation_pending' })
    const request = (async () => {
      try {
        await lockConsole()
        if (mounted.current && generation.current === current) {
          setSession({ state: 'locked', notice: rememberLock(false) ? null : 'lock_storage_unavailable' })
        }
      } catch {
        if (mounted.current && generation.current === current) {
          setSession({ state: 'locked', notice: 'revocation_unconfirmed' })
        }
      }
    })()
    pendingLock.current = request
    void request.finally(() => { if (pendingLock.current === request) pendingLock.current = null })
    return request
  }, [])

  const onRetry = useCallback(() => {
    if (pendingLock.current) return pendingLock.current
    if (session.notice === 'revocation_unconfirmed') return onLock()
    if (session.notice === 'lock_storage_unavailable' && !rememberLock(false)) return Promise.resolve()
    setSession({ state: 'checking', notice: null })
    return probe()
  }, [session.notice, onLock, probe])

  return { ...session, lockPersistenceError, onUnlocked, onLock, onRetry }
}
