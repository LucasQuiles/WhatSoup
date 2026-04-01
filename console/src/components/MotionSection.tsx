import { type FC, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { staggerChildVariants } from '../lib/motion'

interface MotionSectionProps {
  children: ReactNode
  delay?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * Fade-up entrance animation for page sections.
 * Design spec: 0.5s duration, staggered 50ms per section.
 * Uses the design system easing: cubic-bezier(0.22, 1, 0.36, 1)
 */
const MotionSection: FC<MotionSectionProps> = ({ children, delay = 0, className, style }) => (
  <motion.div
    initial={{ opacity: 0, y: 12 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{
      duration: 0.5,
      delay,
      ease: [0.22, 1, 0.36, 1],
    }}
    className={className}
    style={style}
  >
    {children}
  </motion.div>
)

export default MotionSection

/**
 * Stagger container for child elements.
 * Automatically staggers children by 50ms each.
 */
export const StaggerContainer: FC<{
  children: ReactNode
  className?: string
  style?: React.CSSProperties
  staggerDelay?: number
}> = ({ children, className, style, staggerDelay = 0.05 }) => (
  <motion.div
    initial="hidden"
    animate="visible"
    variants={{
      hidden: {},
      visible: { transition: { staggerChildren: staggerDelay } },
    }}
    className={className}
    style={style}
  >
    {children}
  </motion.div>
)

/**
 * Stagger child — auto-animated by StaggerContainer parent.
 */
export const MotionChild: FC<{
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}> = ({ children, className, style }) => (
  <motion.div variants={staggerChildVariants} className={className} style={style}>
    {children}
  </motion.div>
)
