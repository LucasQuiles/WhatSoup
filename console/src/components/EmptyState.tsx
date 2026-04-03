import { type FC, type ReactNode } from 'react'
import { motion } from 'framer-motion'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
}

const ease = [0.22, 1, 0.36, 1] as const

const EmptyState: FC<EmptyStateProps> = ({ icon, title, description }) => {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{ padding: 'var(--sp-8) var(--sp-6)' }}
    >
      <motion.div
        className="text-t5 mb-4"
        style={{ width: 'var(--icon-empty)', height: 'var(--icon-empty)' }}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease }}
      >
        {icon}
      </motion.div>
      <motion.div
        className="font-sans font-semibold text-t3"
        style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--sp-1)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease, delay: 0.1 }}
      >
        {title}
      </motion.div>
      {description && (
        <motion.div
          className="text-t4 leading-relaxed"
          style={{ fontSize: 'var(--font-size-body)', maxWidth: 'var(--empty-max-w)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease, delay: 0.15 }}
        >
          {description}
        </motion.div>
      )}
    </div>
  )
}

export default EmptyState
