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
  success: 'rgba(45,212,168,0.2)',
  error: 'rgba(252,129,129,0.2)',
  info: 'rgba(56,189,248,0.2)',
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
      className="flex items-center gap-2.5"
      style={{
        padding: '10px 16px',
        borderRadius: '8px',
        fontSize: '0.85rem',
        fontWeight: 500,
        border: `1px solid ${borderColor[variant]}`,
        background: 'var(--color-d3)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        maxWidth: '360px',
      }}
    >
      <Icon size={18} strokeWidth={1.75} className={`flex-shrink-0 ${iconColor[variant]}`} />
      <span className="flex-1 text-t2">{message}</span>
      <button
        onClick={onClose}
        className="text-t5 hover:text-t3 cursor-pointer transition-colors"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}

export default Toast
