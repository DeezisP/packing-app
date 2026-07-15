import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { formatBytes, formatDuration, formatDateTime } from '../../lib/format'
import { strings } from '../../lib/strings'
import type { RecordingRecord, SystemStatusInfo } from '../../../electron/shared/types'

const POLL_MS = 5000
const T = strings.bottomPanel

export function BottomPanel(): JSX.Element {
  const [status, setStatus] = useState<SystemStatusInfo | null>(null)
  const [recent, setRecent] = useState<RecordingRecord[]>([])

  useEffect(() => {
    let cancelled = false

    async function refresh(): Promise<void> {
      const [s, r] = await Promise.all([
        window.electronAPI.system.getStatus(),
        window.electronAPI.recordings.getRecent(6)
      ])
      if (!cancelled) {
        setStatus(s)
        setRecent(r)
      }
    }

    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="glass border-t border-white/10 rounded-none px-6 py-3 grid grid-cols-1 lg:grid-cols-3 gap-6 text-sm">
      <div>
        <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">{T.recentRecordings}</h3>
        <ul className="space-y-1 max-h-24 overflow-auto">
          {recent.length === 0 && <li className="text-slate-600">{T.noRecordingsYet}</li>}
          {recent.map((r) => (
            <li key={r.id} className="flex items-center justify-between text-slate-300">
              <span className="font-mono">{r.barcode}</span>
              <span className="text-slate-500">{r.station}</span>
              <span className="text-slate-500">{formatDateTime(r.createdDate)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">{T.diskUsage}</h3>
        {status && (
          <>
            <div className="w-full h-2 bg-surface-700/60 rounded-full overflow-hidden">
              <motion.div
                className={`h-full ${status.disk.lowDiskWarning ? 'bg-rec-500' : 'bg-accent-500'}`}
                animate={{ width: `${status.disk.usedPercent}%` }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </div>
            <p className="text-slate-400 mt-2">
              {T.freeOfTotal(formatBytes(status.disk.freeBytes), formatBytes(status.disk.totalBytes))}
              {status.disk.lowDiskWarning && <span className="text-rec-500 ml-2">{T.lowDiskSpace}</span>}
            </p>
          </>
        )}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">{T.systemStatus}</h3>
        {status && (
          <ul className="text-slate-400 space-y-0.5">
            <li>{T.uptime(formatDuration(status.uptimeSeconds))}</li>
            <li>{T.totalRecordings(status.totalRecordings)}</li>
            <li>{T.activeRecordings(status.activeRecordings)}</li>
          </ul>
        )}
      </div>
    </div>
  )
}
