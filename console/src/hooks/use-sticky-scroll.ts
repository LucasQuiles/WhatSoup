import { useRef, useLayoutEffect, useEffect, useCallback, useState } from 'react'

/**
 * Shared auto-scroll hook for chat-like containers.
 *
 * Pinned to bottom by default. Detaches on scroll up (>150px).
 * Re-attaches on scroll back down (within 150px). Shows jump
 * button when >200px away.
 */
export function useStickyScroll<T>(items: T[], key: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)
  const needsPinRef = useRef(true)

  // Key change → force pin on next layout effect
  useEffect(() => {
    needsPinRef.current = true
    // Defer state update to avoid cascading render warning
    queueMicrotask(() => setShowJump(false))
  }, [key])

  // After DOM updates: scroll if pinned or near bottom
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || items.length === 0) return

    if (needsPinRef.current) {
      el.scrollTop = el.scrollHeight
      needsPinRef.current = false
      return
    }

    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    if (gap <= 150) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowJump(gap > 200)
  }, [])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    needsPinRef.current = false
    setShowJump(false)
  }, [])

  return { scrollRef, showJump, handleScroll, jumpToBottom }
}
