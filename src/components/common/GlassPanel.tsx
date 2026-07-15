import { motion, type HTMLMotionProps } from 'framer-motion'
import { forwardRef } from 'react'

interface GlassPanelProps extends HTMLMotionProps<'div'> {
  /** Denser tint + lift-on-hover, for clickable cards (e.g. StationCard). */
  interactive?: boolean
  /** Higher-opacity tint, for surfaces that sit on top of other glass (dialogs, toasts). */
  strong?: boolean
  /** Skip the mount fade/scale-in - used when a parent AnimatePresence already animates this element. */
  noEnterAnimation?: boolean
}

const ENTER = {
  initial: { opacity: 0, scale: 0.98, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  // Also doubles as the exit target so panels inside <AnimatePresence>
  // (station cards, scanner cards) fade/shrink out on removal instead of
  // just vanishing - AnimatePresence only animates an unmount if the
  // component being removed declares an `exit` variant.
  exit: { opacity: 0, scale: 0.97, y: -6 },
  transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] as const }
}

/** The one place every frosted-glass surface in the app is defined - rounded
 *  corners, translucent blurred background, hairline border, soft shadow.
 *  Everything else (dialogs, toasts, station cards, section panels) wraps
 *  this instead of repeating the same Tailwind class soup. */
export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  { interactive, strong, noEnterAnimation, className = '', children, ...rest },
  ref
) {
  return (
    <motion.div
      ref={ref}
      className={`glass ${strong ? 'glass-strong' : ''} ${interactive ? 'glass-interactive cursor-pointer' : ''} ${className}`}
      {...(noEnterAnimation ? {} : ENTER)}
      {...rest}
    >
      {children}
    </motion.div>
  )
})
