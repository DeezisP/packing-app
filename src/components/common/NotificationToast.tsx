import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

type Tone = 'info' | 'success' | 'warning' | 'danger'

interface NotificationToastProps {
  tone?: Tone
  title: string
  children?: ReactNode
  onDismiss?: () => void
}

const TONE_ACCENT: Record<Tone, string> = {
  info: 'text-accent-500',
  success: 'text-ok-500',
  warning: 'text-warn-500',
  danger: 'text-rec-500'
}

/** Slide-and-fade toast anchored bottom-right. Like AnimatedDialog, callers
 *  wrap their `{event && <NotificationToast>}` in <AnimatePresence> for the
 *  exit animation. */
export function NotificationToast({ tone = 'info', title, children, onDismiss }: NotificationToastProps): JSX.Element {
  return (
    <motion.div
      className="glass glass-strong fixed bottom-6 right-6 max-w-sm px-5 py-4 z-50"
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={`font-semibold ${TONE_ACCENT[tone]}`}>{title}</p>
        {onDismiss && (
          <button onClick={onDismiss} className="text-slate-500 hover:text-slate-300 text-xs leading-none mt-0.5">
            ✕
          </button>
        )}
      </div>
      {children && <div className="text-sm text-slate-300 mt-1.5 space-y-1">{children}</div>}
    </motion.div>
  )
}
