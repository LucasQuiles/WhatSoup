import { useState, useCallback, type FC, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Toast from '../components/Toast'
import { ToastContext, type ToastVariant, type ToastItem, type ToastContextValue } from './toast-context'

let nextId = 0

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const toast = useCallback((variant: ToastVariant, message: string) => {
    const id = nextId++
    setToasts(prev => [...prev, { id, variant, message }])
  }, [])

  const remove = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const value: ToastContextValue = {
    toast,
    success: useCallback((msg: string) => toast('success', msg), [toast]),
    error: useCallback((msg: string) => toast('error', msg), [toast]),
    info: useCallback((msg: string) => toast('info', msg), [toast]),
  }

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Toast stack — fixed bottom-right */}
      <div
        className="fixed z-50 flex flex-col gap-2"
        style={{ bottom: 'var(--sp-5)', right: 'var(--sp-5)', pointerEvents: 'none' }}
      >
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              style={{ pointerEvents: 'auto' }}
            >
              <Toast
                variant={t.variant}
                message={t.message}
                onClose={() => remove(t.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

