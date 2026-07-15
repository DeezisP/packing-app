import { motion, AnimatePresence } from 'framer-motion'
import { AnimatedButton } from './AnimatedButton'
import { strings } from '../../lib/strings'
import type { UpdateState } from '../../../electron/shared/types'

interface Props {
  state: UpdateState
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
  showCheckButton?: boolean
}

const T = strings.updatePanel

export function UpdatePanel({ state, onCheck, onDownload, onInstall, showCheckButton = true }: Props): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="block text-xs text-slate-500">{T.currentVersion}</span>
          <span className="font-mono text-slate-200">{state.currentVersion || '-'}</span>
        </div>
        <div>
          <span className="block text-xs text-slate-500">{T.latestVersion}</span>
          <span className="font-mono text-slate-200">{state.latestVersion ?? '-'}</span>
        </div>
      </div>

      <StatusLine state={state} />

      {state.status === 'available' && state.releaseNotes && (
        <div className="bg-surface-800/50 border border-white/10 rounded-lg p-3 text-xs text-slate-300 max-h-32 overflow-auto whitespace-pre-wrap">
          {state.releaseNotes}
        </div>
      )}

      {state.status === 'downloading' && (
        <div className="w-full h-2 bg-surface-700/60 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-accent-500"
            animate={{ width: `${state.progressPercent ?? 0}%` }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          />
        </div>
      )}

      <div className="flex gap-2">
        {showCheckButton && state.status !== 'downloading' && state.status !== 'downloaded' && (
          <AnimatedButton onClick={onCheck}>{state.status === 'checking' ? T.checking : T.checkForUpdates}</AnimatedButton>
        )}
        {state.status === 'available' && (
          <AnimatedButton variant="primary" onClick={onDownload}>
            {T.downloadAndInstall}
          </AnimatedButton>
        )}
        {state.status === 'downloaded' && (
          <div className="flex flex-col gap-1">
            <AnimatedButton variant="success" onClick={onInstall}>
              {T.restartAndInstall}
            </AnimatedButton>
            <span className="text-xs text-slate-500">{T.restartNote}</span>
          </div>
        )}
        {state.status === 'error' && !showCheckButton && <AnimatedButton onClick={onCheck}>{strings.common.retry}</AnimatedButton>}
      </div>
    </div>
  )
}

function StatusLine({ state }: { state: UpdateState }): JSX.Element {
  const text = (() => {
    switch (state.status) {
      case 'idle':
        return T.statusIdle
      case 'checking':
        return T.statusChecking
      case 'available':
        return T.statusAvailable
      case 'not-available':
        return T.statusNotAvailable
      case 'downloading':
        return T.statusDownloading(state.progressPercent ?? 0)
      case 'downloaded':
        return T.statusDownloaded
      case 'error':
        return state.error ?? T.statusErrorFallback
      default:
        return ''
    }
  })()

  const colorClass =
    state.status === 'available'
      ? 'text-accent-500'
      : state.status === 'not-available' || state.status === 'downloaded'
        ? 'text-ok-500'
        : state.status === 'error'
          ? 'text-rec-500'
          : 'text-slate-400'

  return (
    <AnimatePresence mode="wait">
      <motion.p
        key={state.status + text}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className={`text-sm ${colorClass}`}
      >
        {text}
      </motion.p>
    </AnimatePresence>
  )
}
