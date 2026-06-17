import { type FC, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, WifiOff } from 'lucide-react'
import { Button } from './primitives/Button'

type EmptyStateVariant = 'default' | 'error' | 'offline'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  /**
   * Visual variant:
   *  - `default` — neutral empty result (text-3 icon, text-2 title)
   *  - `error`   — failed operation (crit channel)
   *  - `offline` — transport loss with cached data (warn channel, DD-29)
   */
  variant?: EmptyStateVariant
  /** Retry callback — shows a retry button when provided */
  onRetry?: () => void
  /** Custom retry label */
  retryLabel?: string
}

const ease = [0.22, 1, 0.36, 1] as const

/**
 * Per-variant tone mapping. `default` and `error` reproduce the original
 * byte-faithful class strings; `offline` carries the warn channel (DD-29).
 */
interface VariantTone {
  /** Icon wrapper ink + spacing class. */
  iconClass: string
  /** Title ink class. */
  titleClass: string
  /** Default lucide icon when no `icon` prop is supplied (null = no icon). */
  defaultIcon: ReactNode | null
}

const VARIANT_TONE: Record<EmptyStateVariant, VariantTone> = {
  default: {
    iconClass: 'text-text-3 mb-4',
    titleClass: 'text-text-2',
    defaultIcon: null,
  },
  error: {
    iconClass: 'text-s-crit mb-4',
    titleClass: 'text-s-crit',
    defaultIcon: <AlertTriangle size={40} strokeWidth={1.25} />,
  },
  offline: {
    iconClass: 'text-s-warn mb-4',
    titleClass: 'text-s-warn',
    defaultIcon: <WifiOff size={40} strokeWidth={1.25} />,
  },
}

const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  variant = 'default',
  onRetry,
  retryLabel = 'Try again',
}) => {
  const tone = VARIANT_TONE[variant]
  const resolvedIcon = icon ?? tone.defaultIcon

  return (
    <div
      className="flex flex-col items-center justify-center text-center py-[var(--sp-8)] px-[var(--sp-6)]"
    >
      {resolvedIcon && (
        <motion.div
          className={`w-[var(--icon-empty)] h-[var(--icon-empty)] ${tone.iconClass}`}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease }}
        >
          {resolvedIcon}
        </motion.div>
      )}
      <motion.div
        className={`font-sans font-semibold mb-[var(--sp-1)] text-lg ${tone.titleClass}`}
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
