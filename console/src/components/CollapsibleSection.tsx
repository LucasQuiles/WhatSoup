import { type FC, type ReactNode, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

interface CollapsibleSectionProps {
  title: string
  defaultOpen?: boolean
  badge?: string
  children: ReactNode
}

const CollapsibleSection: FC<CollapsibleSectionProps> = ({
  title,
  defaultOpen = false,
  badge,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center cursor-pointer c-hover"
        style={{
          padding: 'var(--sp-3) var(--sp-4)',
          borderBottom: 'var(--bw) solid var(--b1)',
          background: 'none',
          border: 'none',
          borderBlockEnd: 'var(--bw) solid var(--b1)',
        }}
      >
        <span className="c-heading flex-1 text-left">{title}</span>
        {badge && (
          <span
            className="c-label"
            style={{
              background: 'var(--color-d4)',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--sp-1) var(--sp-2)',
              marginRight: 'var(--sp-2)',
            }}
          >
            {badge}
          </span>
        )}
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="inline-flex items-center"
          style={{ color: 'var(--color-t3)' }}
        >
          <ChevronDown style={{ width: 'var(--sp-4)', height: 'var(--sp-4)' }} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: 'var(--sp-4)' }}>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default CollapsibleSection
