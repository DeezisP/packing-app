import { useCameraPreview } from '../../hooks/useCameraPreview'
import { useOverlayFieldData } from '../../hooks/useOverlayFieldData'
import { formatDuration } from '../../lib/format'
import { OverlayPreview } from '../common/OverlayPreview'
import type { StationConfig, StationRuntimeState, OverlayConfig } from '../../../electron/shared/types'

interface Props {
  station: StationConfig
  state: StationRuntimeState | undefined
  overlayConfig: OverlayConfig
  isActive: boolean
  hotkey: number
  onSetActive: () => void
}

export function StationPanel({ station, state, overlayConfig, isActive, hotkey, onSetActive }: Props): JSX.Element {
  const { videoRef, error: previewError } = useCameraPreview(station.cameraName)
  const overlayData = useOverlayFieldData(station, state)
  const status = state?.status ?? 'idle'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSetActive}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSetActive()
      }}
      className={`flex flex-col rounded-xl border bg-surface-900 overflow-hidden transition-colors ${
        isActive ? 'border-accent-500 ring-1 ring-accent-500' : 'border-surface-700'
      }`}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">{station.name}</span>
          {isActive && (
            <span className="text-[10px] uppercase tracking-wide bg-accent-600/20 text-accent-500 px-1.5 py-0.5 rounded">
              Active ({hotkey})
            </span>
          )}
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="relative aspect-video bg-black">
        <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
        {station.cameraName && <OverlayPreview config={overlayConfig} data={overlayData} />}
        {!station.cameraName && (
          // Fixed (non-theme-remapped) gray - this sits on the permanently-black
          // camera viewport, not the app's surface background, so it must stay
          // legible regardless of light/dark theme.
          <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
            No camera assigned
          </div>
        )}
        {station.cameraName && previewError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-warn-500 text-sm px-4 text-center">
            Preview unavailable: {previewError}
          </div>
        )}
        {state && !state.cameraConnected && station.cameraName && (
          <div className="absolute top-2 left-2 bg-rec-600/90 text-white text-xs px-2 py-1 rounded">
            Camera disconnected
          </div>
        )}
        {status === 'recording' && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 px-2 py-1 rounded">
            <span className="rec-dot" />
            <span className="text-xs font-mono text-white">{formatDuration(state?.elapsedSeconds ?? 0)}</span>
          </div>
        )}
      </div>

      <div className="p-4 space-y-2">
        <Row label="Camera" value={station.cameraName ?? 'Not assigned'} />
        <ScannerRow station={station} state={state} />
        <Row
          label="Barcode"
          value={state?.barcode ?? 'Waiting for barcode...'}
          emphasize={Boolean(state?.barcode)}
        />
        {status === 'error' && state?.lastError && (
          <div className="text-xs text-rec-500 bg-rec-500/10 rounded px-2 py-1.5">{state.lastError}</div>
        )}
        {station.scannerDeviceId && state && !state.scannerConnected && (
          <div className="text-xs text-warn-500 bg-warn-500/10 rounded px-2 py-1.5">
            Paired scanner disconnected - this station can still be operated via the active-station
            selector until it reconnects.
          </div>
        )}
      </div>
    </div>
  )
}

function ScannerRow({
  station,
  state
}: {
  station: StationConfig
  state: StationRuntimeState | undefined
}): JSX.Element {
  if (!station.scannerDeviceId) {
    return <Row label="Scanner" value="Not paired" />
  }
  const connected = state?.scannerConnected ?? false
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">Scanner</span>
      <span className="flex items-center gap-1.5 text-slate-300">
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-ok-500' : 'bg-rec-500'}`} />
        {state?.scannerName ?? 'Paired scanner'}
        <span className={connected ? 'text-ok-500' : 'text-rec-500'}>
          ({connected ? 'Connected' : 'Disconnected'})
        </span>
      </span>
    </div>
  )
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={emphasize ? 'font-mono font-semibold text-slate-100' : 'text-slate-300'}>{value}</span>
    </div>
  )
}

function StatusBadge({ status }: { status: StationRuntimeState['status'] }): JSX.Element {
  const map: Record<StationRuntimeState['status'], { label: string; className: string }> = {
    idle: { label: 'Waiting', className: 'bg-surface-700 text-slate-300' },
    recording: { label: 'Recording', className: 'bg-rec-600/20 text-rec-500' },
    error: { label: 'Error', className: 'bg-warn-500/20 text-warn-500' }
  }
  const cfg = map[status]
  return <span className={`text-xs font-medium px-2 py-1 rounded ${cfg.className}`}>{cfg.label}</span>
}
