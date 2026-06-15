import { type FC, useEffect } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import type { ToastVariant } from '../hooks/toast-context'
import { TOAST_BORDER_COLOR, TOAST_ICON_CLASS } from '../lib/color-semantics'
import { Button } from './primitives/Button'

interface ToastProps {
  variant: ToastVariant
  message: string
  onClose: () => void
  duration?: number
}

const icons: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const Toast: FC<ToastProps> = ({ variant, message, onClose, duration = 4000 }) => {
  const Icon = icons[variant]

  useEffect(() => {
    const timer = setTimeout(onClose, duration)
    return () => clearTimeout(timer)
  }, [onClose, duration])

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-center gap-2.5 font-medium rounded-md bg-d3 shadow-[var(--shadow-md)] max-w-[var(--toast-max-w)] py-[var(--sp-2h)] px-[var(--sp-4)] text-body"
      style={{
        borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: TOAST_BORDER_COLOR[variant],
      }}
    >
      <Icon size={18} strokeWidth={1.75} className={`flex-shrink-0 ${TOAST_ICON_CLASS[variant]}`} />
      <span className="flex-1 text-t2">{message}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        aria-label="Dismiss notification"
        icon={<X size={14} strokeWidth={1.75} />}
      />
    </div>
  )
}

export default Toast
