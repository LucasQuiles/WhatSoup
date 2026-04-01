import { createContext, useContext, useState, useCallback, type FC, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Toast from '../components/Toast'

type ToastVariant = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  variant: ToastVariant
  message: string
}

interface ToastContextValue {
  toast: (variant: ToastVariant, message: string) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

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
        style={{ bottom: '20px', right: '20px', pointerEvents: 'none' }}
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

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
