import { useRef, useLayoutEffect, useEffect, useCallback, useState } from 'react'

/**
 * Shared auto-scroll hook for chat-like containers.
 *
 * Behavior:
 *  - Pinned to bottom by default on mount and key change.
 *  - Detaches when user scrolls >150px from bottom.
 *  - Re-attaches when user scrolls within 150px of bottom.
 *  - Shows "jump to newest" button when detached >200px.
 *
 * @param items  - dependency array (e.g. reversed messages) — triggers scroll check on change
 * @param key    - reset key (e.g. selectedChat) — force-pin on change
 */
export function useStickyScroll<T>(items: T[], key: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)
  const forcePinRef = useRef(true)

  // On key change: force pin
  useEffect(() => {
    forcePinRef.current = true
  }, [key])

  // After every render where items changed: scroll to bottom if pinned
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (forcePinRef.current) {
      el.scrollTop = el.scrollHeight
      if (items.length > 0) forcePinRef.current = false
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
    setShowJump(false)
  }, [])

  return { scrollRef, showJump, handleScroll, jumpToBottom }
}
