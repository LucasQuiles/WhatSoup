import { useRef, useLayoutEffect, useCallback, useState } from 'react'

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
  const prevKeyRef = useRef(key)

  // Key change: force-pin — runs synchronously in useLayoutEffect before paint
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [key])

  // Items change: scroll to bottom if already near bottom
  useLayoutEffect(() => {
    // Skip if key just changed (the key effect already scrolled)
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key
      return
    }

    const el = scrollRef.current
    if (!el) return

    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    if (gap <= 150) {
      el.scrollTop = el.scrollHeight
    }
  }, [items, key])

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
