import { useRef, useLayoutEffect, useEffect, useCallback, useState } from 'react'

/**
 * Shared auto-scroll hook for chat-like containers.
 *
 * Strategy: track whether we WERE at the bottom before new content arrived.
 * If yes, scroll to the new bottom. If no, stay put.
 */
export function useStickyScroll<T>(items: T[], key: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)
  const needsPinRef = useRef(true)
  const wasAtBottomRef = useRef(true)

  // Key change → force pin
  useEffect(() => {
    needsPinRef.current = true
    wasAtBottomRef.current = true
    queueMicrotask(() => setShowJump(false))
  }, [key])

  // BEFORE render paints: capture whether we're currently at the bottom.
  // This runs synchronously after React commits DOM changes but before paint.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || items.length === 0) return

    if (needsPinRef.current) {
      // Force pin: chat switch or first data load
      el.scrollTop = el.scrollHeight
      needsPinRef.current = false
      wasAtBottomRef.current = true
      return
    }

    // Were we at the bottom BEFORE this render added new content?
    // If yes, follow the new content down.
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  // Scroll handler: track whether user is at bottom, update jump button
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    // At bottom = within 50px (tolerance for sub-pixel and small additions)
    wasAtBottomRef.current = gap <= 50
    setShowJump(gap > 200)
  }, [])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    wasAtBottomRef.current = true
    needsPinRef.current = false
    setShowJump(false)
  }, [])

  return { scrollRef, showJump, handleScroll, jumpToBottom }
}
