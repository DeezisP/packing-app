import { motion } from 'framer-motion'
import { strings } from '../../lib/strings'
import type { SaveLocationStatus } from '../../../electron/shared/types'

interface Props {
  status: SaveLocationStatus
}

/** Persistent, app-wide banner - shown on every tab, not just Settings -
 *  because an unwritable save folder blocks new recordings everywhere.
 *  Takes the already-unwritable status as a prop (rather than reading the
 *  hook itself) so the caller can conditionally mount/unmount it directly
 *  inside <AnimatePresence>, which is what makes the exit animation play -
 *  AnimatePresence only detects presence changes in its own direct children,
 *  not a child's internal `return null`. */
export function SaveLocationWarningBanner({ status }: Props): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="bg-rec-600/90 backdrop-blur-sm text-white text-sm px-6 py-2 flex items-center justify-between overflow-hidden"
    >
      <span>
        <strong>{strings.saveLocationBanner.prefix}</strong> {status.error ?? strings.saveLocationBanner.fallback}{' '}
        {strings.saveLocationBanner.suffix}
      </span>
      <span className="font-mono text-xs opacity-80">{status.path}</span>
    </motion.div>
  )
}
