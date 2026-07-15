import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { VideoPlayerModal } from '../components/search/VideoPlayerModal'
import { GlassPanel } from '../components/common/GlassPanel'
import { formatDateTime, formatDuration } from '../lib/format'
import { strings } from '../lib/strings'
import type { AppConfig, RecordingRecord, SearchFilters } from '../../electron/shared/types'

interface Props {
  config: AppConfig
}

const T = strings.search

export function SearchPage({ config }: Props): JSX.Element {
  const [filters, setFilters] = useState<SearchFilters>({})
  const [results, setResults] = useState<RecordingRecord[]>([])
  const [selected, setSelected] = useState<RecordingRecord | null>(null)
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
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">{T.colThumbnail}</th>
              <th className="text-left px-4 py-2">{T.colBarcode}</th>
              <th className="text-left px-4 py-2">{T.colStation}</th>
              <th className="text-left px-4 py-2">{T.colCamera}</th>
              <th className="text-left px-4 py-2">{T.colDuration}</th>
              <th className="text-left px-4 py-2">{T.colStatus}</th>
              <th className="text-left px-4 py-2">{T.colCreated}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr
                key={r.id}
                onDoubleClick={() => setSelected(r)}
                className="cv-row border-t border-white/5 hover:bg-white/[0.04] transition-colors duration-150 cursor-pointer"
              >
                <td className="px-4 py-2">
                  {r.thumbnailUrl ? (
                    <img src={r.thumbnailUrl} className="w-16 h-9 object-cover rounded-md" />
                  ) : (
                    <div className="w-16 h-9 bg-surface-800/60 rounded-md" />
                  )}
                </td>
                <td className="px-4 py-2 font-mono">{r.barcode}</td>
                <td className="px-4 py-2 text-slate-400">{r.station}</td>
                <td className="px-4 py-2 text-slate-400">{r.camera}</td>
                <td className="px-4 py-2 text-slate-400">{r.durationSeconds != null ? formatDuration(r.durationSeconds) : '-'}</td>
                <td className="px-4 py-2">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-4 py-2 text-slate-500">{formatDateTime(r.createdDate)}</td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-600">
                  {T.noResults}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </GlassPanel>

      <AnimatePresence>
        {selected && <VideoPlayerModal key="video-player" recording={selected} onClose={() => setSelected(null)} />}
      </AnimatePresence>
    </div>
  )
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
