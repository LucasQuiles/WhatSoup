/** Shared framer-motion variants and motion-token mirrors. */
export const motionDurations = {
  fast: 0.12,
  base: 0.18,
  slow: 0.28,
} as const

export const motionEasings = {
  enter: [0.2, 0, 0, 1] as const,
  exit: [0.4, 0, 1, 1] as const,
} as const

export const staggerChildVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  },
} as const

export const toastMotion = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: motionDurations.base, ease: motionEasings.enter },
  },
  exit: {
    opacity: 0,
    transition: { duration: motionDurations.fast, ease: motionEasings.exit },
  },
} as const
