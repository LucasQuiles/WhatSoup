import { useState, useRef, useCallback, type FC, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import Toast from '../components/Toast'
import { ToastContext, type ToastVariant, type ToastItem, type ToastContextValue } from './toast-context'
import { toastMotion } from '../lib/motion'

/** Maximum number of toasts displayed simultaneously. When the cap is reached
 *  the oldest toast is evicted to make room for the new one. This prevents
 *  unbounded queue growth during rapid error/notification storms. */
export const MAX_TOASTS = 5

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextIdRef = useRef<number>(0)

  const toast = useCallback((variant: ToastVariant, message: string) => {
    const id = ++nextIdRef.current
    setToasts(prev => [...prev, { id, variant, message }].slice(-MAX_TOASTS))
    return id
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const clear = useCallback(() => {
    setToasts([])
  }, [])

  const value: ToastContextValue = {
    toast,
    success: useCallback((msg: string) => toast('success', msg), [toast]),
    error: useCallback((msg: string) => toast('error', msg), [toast]),
    info: useCallback((msg: string) => toast('info', msg), [toast]),
    dismiss,
    clear,
  }

  // The toast stack portals to document.body so that #root inert (applied when a
  // modal is open) cannot suppress live-region announcements or dead-zone the
  // dismiss buttons (B5 §5.6, C-B5-3). Its MotionConfig is local because the
  // provider wraps App, so App's MotionConfig does not cover the portal stack.
  const toastStack = (
    <MotionConfig reducedMotion="user">
      <div
        className="fixed bottom-[var(--sp-5)] right-[var(--sp-5)] z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none"
      >
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              initial={toastMotion.initial}
              animate={toastMotion.animate}
              exit={toastMotion.exit}
              className="pointer-events-auto"
            >
              <Toast
                variant={t.variant}
                message={t.message}
                onClose={() => dismiss(t.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(toastStack, document.body)
        : toastStack}
    </ToastContext.Provider>
  )
}
