import { memo } from 'react'
import { GlassPanel } from '../common/GlassPanel'
import { CameraPreview } from '../common/CameraPreview'
import { DeviceStatus } from '../common/DeviceStatus'
import { RecordingStatus } from '../common/RecordingStatus'
import { useOverlayFieldData } from '../../hooks/useOverlayFieldData'
import { OverlayPreview } from '../common/OverlayPreview'
import { strings } from '../../lib/strings'
import type { StationConfig, StationRuntimeState, OverlayConfig } from '../../../electron/shared/types'

interface Props {
  station: StationConfig
  state: StationRuntimeState | undefined
  overlayConfig: OverlayConfig
  isActive: boolean
  hotkey: number
  onSetActive: () => void
}

/** One packing station's live card: camera feed (with burned-overlay
 *  preview), scanner/camera pairing status, and the current barcode/timer.
 *  Dashboard renders one of these per entry in config.stations - nothing
 *  here assumes a fixed station count or a specific station id. */
function StationCardImpl({ station, state, overlayConfig, isActive, hotkey, onSetActive }: Props): JSX.Element {
  const overlayData = useOverlayFieldData(station, state)
  const status = state?.status ?? 'idle'

  return (
    <GlassPanel
      layout
      interactive
      role="button"
      tabIndex={0}
      onClick={onSetActive}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSetActive()
      }}
      className={`flex flex-col overflow-hidden ${isActive ? 'ring-2 ring-accent-500' : ''}`}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-slate-200 truncate">{station.name}</span>
          {isActive && (
            <span className="text-[10px] uppercase tracking-wide bg-accent-600/25 text-accent-500 px-1.5 py-0.5 rounded-full shrink-0">
              {strings.stationCard.active(hotkey)}
            </span>
          )}
        </div>
        <RecordingStatus status={status} />
      </div>

      <CameraPreview
        cameraName={station.cameraName}
        overlay={station.cameraName ? <OverlayPreview config={overlayConfig} data={overlayData} /> : undefined}
      >
        {state && !state.cameraConnected && station.cameraName && (
          <div className="absolute top-2 left-2 bg-rec-600/90 text-white text-xs px-2 py-1 rounded-full">
            {strings.stationCard.cameraDisconnected}
          </div>
        )}
        <RecordingStatus status={status} variant="live" elapsedSeconds={state?.elapsedSeconds ?? 0} />
      </CameraPreview>

      <div className="p-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">{strings.stationCard.camera}</span>
          <span className="text-slate-300 truncate max-w-[60%]">{station.cameraName ?? strings.common.notAssigned}</span>
        </div>
        <DeviceStatus
          label={strings.stationCard.scanner}
          connected={state?.scannerConnected ?? false}
          detail={station.scannerDeviceId ? (state?.scannerName ?? null) : null}
          emptyText={strings.common.notPaired}
        />
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">{strings.stationCard.barcode}</span>
          <span
            className={
              state?.barcode ? 'font-mono font-semibold text-slate-100' : 'text-slate-300'
            }
          >
            {state?.barcode ?? strings.stationCard.waitingForBarcode}
          </span>
        </div>
        {status === 'error' && state?.lastError && (
          <div className="text-xs text-rec-500 bg-rec-500/10 rounded-lg px-2 py-1.5">{state.lastError}</div>
        )}
        {station.scannerDeviceId && state && !state.scannerConnected && (
          <div className="text-xs text-warn-500 bg-warn-500/10 rounded-lg px-2 py-1.5">
            {strings.stationCard.pairedScannerDisconnected}
          </div>
        )}
      </div>
    </GlassPanel>
  )
}

// Every station's runtime state changes independently (ticking timer,
// scan/connect events) - without memoizing, a 12-station dashboard would
// re-render all 12 cards on every single tick from any one of them.
export const StationCard = memo(StationCardImpl)
