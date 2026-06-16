import { type FC, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { Button } from './primitives/Button'

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
          className={`w-[var(--icon-empty)] h-[var(--icon-empty)] ${isError ? 'text-s-crit mb-4' : 'text-text-3 mb-4'}`}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease }}
        >
          {resolvedIcon}
        </motion.div>
      )}
      <motion.div
        className={`font-sans font-semibold mb-[var(--sp-1)] text-lg ${isError ? 'text-s-crit' : 'text-text-2'}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease, delay: 0.1 }}
      >
        {title}
      </motion.div>
      {description && (
        <motion.div
          className="text-text-2 leading-relaxed max-w-[var(--empty-max-w)] text-body"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease, delay: 0.15 }}
        >
          {description}
        </motion.div>
      )}
      {onRetry && (
        <motion.div
          className="mt-[var(--sp-4)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease, delay: 0.25 }}
        >
          <Button variant="primary" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </motion.div>
      )}
    </div>
  )
}

export default EmptyState
