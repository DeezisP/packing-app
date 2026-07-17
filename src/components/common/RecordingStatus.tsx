import { motion } from 'framer-motion'
import { formatDuration } from '../../lib/format'
import { strings } from '../../lib/strings'

type Status = 'idle' | 'recording' | 'processing' | 'error'

interface RecordingStatusProps {
  status: Status
  /** Renders the small dot+timer chip meant to sit over the video instead of the header pill. */
  variant?: 'badge' | 'live'
  elapsedSeconds?: number
}

const BADGE: Record<Status, { label: string; className: string }> = {
  idle: { label: strings.stationCard.statusIdle, className: 'bg-surface-700/70 text-slate-300' },
  recording: { label: strings.stationCard.statusRecording, className: 'bg-rec-600/25 text-rec-500' },
  processing: { label: strings.stationCard.statusProcessing, className: 'bg-accent-600/25 text-accent-500' },
  error: { label: strings.stationCard.statusError, className: 'bg-warn-500/25 text-warn-500' }
}

/** Status pill for a station's header, and the live rec-dot+timer (or
 *  processing) chip drawn over its camera preview - both driven by the same
 *  StationRuntimeState.status so they can never disagree. */
export function RecordingStatus({ status, variant = 'badge', elapsedSeconds = 0 }: RecordingStatusProps): JSX.Element | null {
  if (variant === 'live') {
    if (status === 'recording') {
      return (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full"
        >
          <span className="rec-dot" />
          <span className="text-xs font-mono text-white">{formatDuration(elapsedSeconds)}</span>
        </motion.div>
      )
    }
    if (status === 'processing') {
      return (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full"
        >
          <span className="processing-dot" />
          <span className="text-xs font-medium text-white">{strings.stationCard.statusProcessing}</span>
        </motion.div>
      )
    }
    return null
  }

  const cfg = BADGE[status]
  return (
    <motion.span
      key={status}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`text-xs font-medium px-2 py-1 rounded-full ${cfg.className}`}
    >
      {cfg.label}
    </motion.span>
  )
}
