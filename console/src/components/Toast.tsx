import { type FC, useEffect } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

type ToastVariant = 'success' | 'error' | 'info'

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

const borderColor: Record<ToastVariant, string> = {
  success: 'var(--s-ok-soft)',
  error: 'var(--s-crit-soft)',
  info: 'var(--m-cht-soft)',
}

const iconColor: Record<ToastVariant, string> = {
  success: 'text-s-ok',
  error: 'text-s-crit',
  info: 'text-m-cht',
}

const Toast: FC<ToastProps> = ({ variant, message, onClose, duration = 4000 }) => {
  const Icon = icons[variant]

  useEffect(() => {
    const timer = setTimeout(onClose, duration)
    return () => clearTimeout(timer)
  }, [onClose, duration])

  return (
    <div
      className="flex items-center gap-2.5 font-medium"
      style={{
        padding: '10px var(--sp-4)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--font-size-body)',
        border: `var(--bw) solid ${borderColor[variant]}`,
        background: 'var(--color-d3)',
        boxShadow: 'var(--shadow-md)',
        maxWidth: 'var(--toast-max-w)',
      }}
    >
      <Icon size={18} strokeWidth={1.75} className={`flex-shrink-0 ${iconColor[variant]}`} />
      <span className="flex-1 text-t2">{message}</span>
      <button
        onClick={onClose}
        className="text-t5 hover:text-t3 cursor-pointer c-hover"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}

export default Toast
