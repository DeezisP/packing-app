import { motion } from 'framer-motion'
import type { ReactNode, MouseEvent } from 'react'

interface AnimatedDialogProps {
  onClose?: () => void
  closeOnBackdrop?: boolean
  maxWidthClassName?: string
  children: ReactNode
}

/** Backdrop + glass panel with enter/exit motion. Not a self-contained
 *  modal manager - callers keep their own `{condition && <AnimatedDialog>}`
 *  and wrap that expression in framer-motion's <AnimatePresence> so the exit
 *  animation plays before the element actually leaves the DOM. */
export function AnimatedDialog({
  onClose,
  closeOnBackdrop = true,
  maxWidthClassName = 'max-w-md',
  children
}: AnimatedDialogProps): JSX.Element {
  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget && closeOnBackdrop) onClose?.()
  }

  return (
    <motion.div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={handleBackdropClick}
    >
      <motion.div
        className={`glass glass-strong w-full ${maxWidthClassName} p-6`}
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}
