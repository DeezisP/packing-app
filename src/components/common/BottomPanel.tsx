import { useEffect, useState } from 'react'
import { formatBytes, formatDuration, formatDateTime } from '../../lib/format'
import type { RecordingRecord, SystemStatusInfo } from '../../../electron/shared/types'

const POLL_MS = 5000

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
    <div className="border-t border-surface-800 bg-surface-900 px-6 py-3 grid grid-cols-1 lg:grid-cols-3 gap-6 text-sm">
      <div>
        <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Recent recordings</h3>
        <ul className="space-y-1 max-h-24 overflow-auto">
          {recent.length === 0 && <li className="text-slate-600">No recordings yet</li>}
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
        <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Disk usage</h3>
        {status && (
          <>
            <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden">
              <div
                className={`h-full ${status.disk.lowDiskWarning ? 'bg-rec-500' : 'bg-accent-500'}`}
                style={{ width: `${status.disk.usedPercent}%` }}
              />
            </div>
            <p className="text-slate-400 mt-2">
              {formatBytes(status.disk.freeBytes)} free of {formatBytes(status.disk.totalBytes)}
              {status.disk.lowDiskWarning && <span className="text-rec-500 ml-2">Low disk space</span>}
            </p>
          </>
        )}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">System status</h3>
        {status && (
          <ul className="text-slate-400 space-y-0.5">
            <li>Uptime: {formatDuration(status.uptimeSeconds)}</li>
            <li>Total recordings: {status.totalRecordings}</li>
            <li>Active recordings: {status.activeRecordings}</li>
          </ul>
        )}
      </div>
    </div>
  )
}
