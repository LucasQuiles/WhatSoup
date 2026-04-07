import { type FC, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  /** Error variant — uses warning icon and critical color */
  variant?: 'default' | 'error'
  /** Retry callback — shows a retry button when provided */
  onRetry?: () => void
  /** Custom retry label */
  retryLabel?: string
}

const ease = [0.22, 1, 0.36, 1] as const

const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  variant = 'default',
  onRetry,
  retryLabel = 'Try again',
}) => {
  const isError = variant === 'error'
  const resolvedIcon = icon ?? (isError
    ? <AlertTriangle size={40} strokeWidth={1.25} />
    : null)

  return (
    <div
      className="flex flex-col items-center justify-center text-center py-[var(--sp-8)] px-[var(--sp-6)]"
    >
      {resolvedIcon && (
        <motion.div
          className={`w-[var(--icon-empty)] h-[var(--icon-empty)] ${isError ? 'text-s-crit mb-4' : 'text-t5 mb-4'}`}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease }}
        >
          {resolvedIcon}
        </motion.div>
      )}
      <motion.div
        className={`font-sans font-semibold mb-[var(--sp-1)] ${isError ? 'text-s-crit' : 'text-t3'}`}
        style={{ fontSize: 'var(--font-size-lg)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease, delay: 0.1 }}
      >
        {title}
      </motion.div>
      {description && (
        <motion.div
          className="text-t4 leading-relaxed max-w-[var(--empty-max-w)]"
          style={{ fontSize: 'var(--font-size-body)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease, delay: 0.15 }}
        >
          {description}
        </motion.div>
      )}
      {onRetry && (
        <motion.button
          className="c-btn c-btn-primary mt-[var(--sp-4)]"
          style={{ fontSize: 'var(--font-size-sm)' }}
          onClick={onRetry}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease, delay: 0.25 }}
        >
          {retryLabel}
        </motion.button>
      )}
    </div>
  )
}

export default EmptyState
