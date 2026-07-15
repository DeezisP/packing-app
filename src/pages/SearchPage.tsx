import { useEffect, useState } from 'react'
import { VideoPlayerModal } from '../components/search/VideoPlayerModal'
import { formatDateTime, formatDuration } from '../lib/format'
import type { AppConfig, RecordingRecord, SearchFilters } from '../../electron/shared/types'

interface Props {
  config: AppConfig
}

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
        <h1 className="text-lg font-semibold text-slate-100">Search Recordings</h1>
        <p className="text-sm text-slate-500">Double-click a row to open the player.</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 bg-surface-900 border border-surface-800 rounded-xl p-4">
        <input
          placeholder="Barcode"
          value={filters.barcode ?? ''}
          onChange={(e) => updateFilter({ barcode: e.target.value || undefined })}
          className="bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
        />
        <select
          value={filters.station ?? ''}
          onChange={(e) => updateFilter({ station: e.target.value || undefined })}
          className="bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All stations</option>
          {config.stations.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={filters.camera ?? ''}
          onChange={(e) => updateFilter({ camera: e.target.value || undefined })}
          className="bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All cameras</option>
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
          className="bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={filters.dateTo ?? ''}
          onChange={(e) => updateFilter({ dateTo: e.target.value || undefined })}
          className="bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div className="bg-surface-900 border border-surface-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-850 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Thumbnail</th>
              <th className="text-left px-4 py-2">Barcode</th>
              <th className="text-left px-4 py-2">Station</th>
              <th className="text-left px-4 py-2">Camera</th>
              <th className="text-left px-4 py-2">Duration</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr
                key={r.id}
                onDoubleClick={() => setSelected(r)}
                className="border-t border-surface-800 hover:bg-surface-850 cursor-pointer"
              >
                <td className="px-4 py-2">
                  {r.thumbnailUrl ? (
                    <img src={r.thumbnailUrl} className="w-16 h-9 object-cover rounded" />
                  ) : (
                    <div className="w-16 h-9 bg-surface-800 rounded" />
                  )}
                </td>
                <td className="px-4 py-2 font-mono">{r.barcode}</td>
                <td className="px-4 py-2 text-slate-400">{r.station}</td>
                <td className="px-4 py-2 text-slate-400">{r.camera}</td>
                <td className="px-4 py-2 text-slate-400">
                  {r.durationSeconds != null ? formatDuration(r.durationSeconds) : '-'}
                </td>
                <td className="px-4 py-2">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-4 py-2 text-slate-500">{formatDateTime(r.createdDate)}</td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-600">
                  No recordings found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <VideoPlayerModal recording={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function StatusPill({ status }: { status: RecordingRecord['status'] }): JSX.Element {
  const map: Record<RecordingRecord['status'], string> = {
    completed: 'bg-ok-500/20 text-ok-500',
    recording: 'bg-rec-500/20 text-rec-500',
    interrupted: 'bg-warn-500/20 text-warn-500',
    error: 'bg-rec-600/20 text-rec-500'
  }
  return <span className={`text-xs px-2 py-0.5 rounded ${map[status]}`}>{status}</span>
}
