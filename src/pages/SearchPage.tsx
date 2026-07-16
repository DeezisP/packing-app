import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { VideoPlayerModal } from '../components/search/VideoPlayerModal'
import { DeleteRecordingDialog } from '../components/search/DeleteRecordingDialog'
import { GlassPanel } from '../components/common/GlassPanel'
import { AnimatedButton } from '../components/common/AnimatedButton'
import { NotificationToast } from '../components/common/NotificationToast'
import { formatDateTime, formatDuration, formatBytes } from '../lib/format'
import { strings } from '../lib/strings'
import type { AppConfig, RecordingRecord, SearchFilters } from '../../electron/shared/types'

interface Props {
  config: AppConfig
}

const T = strings.search

type ToastTone = 'success' | 'danger'
type ToastState = { tone: ToastTone; message: string } | null

export function SearchPage({ config }: Props): JSX.Element {
  const [filters, setFilters] = useState<SearchFilters>({})
  const [results, setResults] = useState<RecordingRecord[]>([])
  const [selected, setSelected] = useState<RecordingRecord | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RecordingRecord | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastState>(null)
  const cameraNames = Array.from(new Set(config.stations.map((s) => s.cameraName).filter(Boolean))) as string[]

  useEffect(() => {
    runSearch(filters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSearch(next: SearchFilters): Promise<void> {
    const rows = await window.electronAPI.recordings.search(next)
    setResults(rows)
  }

  function updateFilter(partial: Partial<SearchFilters>): void {
    const next = { ...filters, ...partial }
    setFilters(next)
    runSearch(next)
  }

  function showToast(tone: ToastTone, message: string): void {
    setToast({ tone, message })
    window.setTimeout(() => setToast(null), 4000)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    const target = pendingDelete
    setDeletingId(target.id)

    // Stop playback immediately if the recording being deleted is currently open.
    if (selected?.id === target.id) setSelected(null)

    try {
      const result = await window.electronAPI.recordings.delete(target.id)
      if (result.success) {
        setResults((prev) => prev.filter((r) => r.id !== target.id))
        showToast('success', T.deleteSuccess(target.barcode))
      } else {
        showToast('danger', T.deleteFailed(result.error ?? T.deleteFailedUnknown))
      }
    } finally {
      setDeletingId(null)
      setPendingDelete(null)
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">{T.title}</h1>
        <p className="text-sm text-slate-500">{T.subtitle}</p>
      </header>

      <GlassPanel className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4">
        <input
          placeholder={T.barcodePlaceholder}
          value={filters.barcode ?? ''}
          onChange={(e) => updateFilter({ barcode: e.target.value || undefined })}
          className="bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
        <select
          value={filters.station ?? ''}
          onChange={(e) => updateFilter({ station: e.target.value || undefined })}
          className="bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">{T.allStations}</option>
          {config.stations.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={filters.camera ?? ''}
          onChange={(e) => updateFilter({ camera: e.target.value || undefined })}
          className="bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">{T.allCameras}</option>
          {cameraNames.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={filters.dateFrom ?? ''}
          onChange={(e) => updateFilter({ dateFrom: e.target.value || undefined })}
          className="bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={filters.dateTo ?? ''}
          onChange={(e) => updateFilter({ dateTo: e.target.value || undefined })}
          className="bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
        />
      </GlassPanel>

      <GlassPanel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">{T.colThumbnail}</th>
                <th className="text-left px-4 py-2">{T.colBarcode}</th>
                <th className="text-left px-4 py-2">{T.colStation}</th>
                <th className="text-left px-4 py-2">{T.colCamera}</th>
                <th className="text-left px-4 py-2">{T.colCreated}</th>
                <th className="text-left px-4 py-2">{T.colDuration}</th>
                <th className="text-left px-4 py-2">{T.colResolution}</th>
                <th className="text-left px-4 py-2">{T.colFileSize}</th>
                <th className="text-left px-4 py-2">{T.colStatus}</th>
                <th className="text-left px-4 py-2">{T.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const isPlayable = r.status === 'completed' || r.status === 'interrupted'
                return (
                <tr
                  key={r.id}
                  onDoubleClick={() => isPlayable && setSelected(r)}
                  className="border-t border-white/5 hover:bg-white/[0.04] transition-colors duration-150 cursor-pointer"
                >
                  <td className="px-4 py-2">
                    <Thumbnail url={r.thumbnailUrl} />
                  </td>
                  <td className="px-4 py-2 font-mono">{r.barcode}</td>
                  <td className="px-4 py-2 text-slate-400">{r.station}</td>
                  <td className="px-4 py-2 text-slate-400">{r.camera}</td>
                  <td className="px-4 py-2 text-slate-500">{formatDateTime(r.createdDate)}</td>
                  <td className="px-4 py-2 text-slate-400">{r.durationSeconds != null ? formatDuration(r.durationSeconds) : '-'}</td>
                  <td className="px-4 py-2 text-slate-400">{r.resolution}</td>
                  <td className="px-4 py-2 text-slate-400">{formatBytes(r.fileSize)}</td>
                  <td className="px-4 py-2">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <AnimatedButton size="sm" disabled={!isPlayable} onClick={() => setSelected(r)}>
                        {T.actionPlay}
                      </AnimatedButton>
                      <AnimatedButton size="sm" onClick={() => window.electronAPI.recordings.openFolder(r.videoPath)}>
                        {T.actionOpenFolder}
                      </AnimatedButton>
                      <AnimatedButton
                        size="sm"
                        variant="danger"
                        disabled={r.status === 'recording' || deletingId === r.id}
                        onClick={() => setPendingDelete(r)}
                      >
                        {deletingId === r.id ? T.deleting : T.actionDelete}
                      </AnimatedButton>
                    </div>
                  </td>
                </tr>
                )
              })}
              {results.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-600">
                    {T.noResults}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </GlassPanel>

      <AnimatePresence>
        {selected && <VideoPlayerModal key="video-player" recording={selected} onClose={() => setSelected(null)} />}
      </AnimatePresence>

      <AnimatePresence>
        {pendingDelete && (
          <DeleteRecordingDialog
            key="delete-recording"
            recording={pendingDelete}
            busy={deletingId === pendingDelete.id}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <NotificationToast key="search-toast" tone={toast.tone} title={toast.message} onDismiss={() => setToast(null)} />
        )}
      </AnimatePresence>
    </div>
  )
}

/** Falls back to the same gray placeholder used for "no thumbnail yet"
 *  whenever the image actually fails to load - a stale/missing/corrupt
 *  thumbnail.jpg (e.g. from a recording too short for the usual 1s-in seek to
 *  land on a frame) previously rendered the browser's broken-image icon
 *  instead. Resets if the url itself changes (e.g. after a search refresh
 *  swaps in a different recording's now-freshly-generated thumbnail). */
function Thumbnail({ url }: { url: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])

  if (!url || failed) {
    return <div className="w-16 h-9 bg-surface-800/60 rounded-md" />
  }
  return <img src={url} onError={() => setFailed(true)} className="w-16 h-9 object-cover rounded-md" />
}

function StatusPill({ status }: { status: RecordingRecord['status'] }): JSX.Element {
  const map: Record<RecordingRecord['status'], { className: string; label: string }> = {
    completed: { className: 'bg-ok-500/20 text-ok-500', label: T.statusCompleted },
    recording: { className: 'bg-rec-500/20 text-rec-500', label: T.statusRecording },
    interrupted: { className: 'bg-warn-500/20 text-warn-500', label: T.statusInterrupted },
    error: { className: 'bg-rec-600/20 text-rec-500', label: T.statusError }
  }
  const cfg = map[status]
  return <span className={`text-xs px-2 py-0.5 rounded-full ${cfg.className}`}>{cfg.label}</span>
}
