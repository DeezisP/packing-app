import { useEffect, useState, useCallback } from 'react'
import { StationPanel } from '../components/dashboard/StationPanel'
import { WrongBarcodeToast } from '../components/dashboard/WrongBarcodeToast'
import { DuplicateBarcodeDialog } from '../components/dashboard/DuplicateBarcodeDialog'
import { UpdateAvailableModal } from '../components/dashboard/UpdateAvailableModal'
import { useBarcodeListener } from '../hooks/useBarcodeListener'
import { useStationsState } from '../hooks/useStationsState'
import { useUpdateState } from '../hooks/useUpdateState'
import { useRawInputDevice } from '../hooks/useRawInputDevice'
import type { AppConfig } from '../../electron/shared/types'

interface Props {
  config: AppConfig
  onConfigChanged: (config: AppConfig) => void
}

export function DashboardPage({ config, onConfigChanged }: Props): JSX.Element {
  const { states, wrongBarcode, duplicateBarcode, dismissDuplicateBarcode } = useStationsState()
  const [activeStationId, setActiveStationId] = useState(config.activeStationId)
  const updateState = useUpdateState()
  const [laterForVersion, setLaterForVersion] = useState<string | null>(null)

  const updateAvailable = updateState.status === 'available' || updateState.status === 'downloaded'
  const showUpdateModal = updateAvailable && laterForVersion !== updateState.latestVersion

  useEffect(() => setActiveStationId(config.activeStationId), [config.activeStationId])

  const setActive = useCallback(
    (stationId: string) => {
      setActiveStationId(stationId)
      window.electronAPI.stations.setActive(stationId)
      window.electronAPI.config.get().then(onConfigChanged)
    },
    [onConfigChanged]
  )

  const getLastRawInputDevice = useRawInputDevice()
  const handleScan = useCallback(
    (barcode: string) => {
      // A scan from a scanner that's paired to a specific station always
      // routes there (resolved main-process side), regardless of which
      // station is "active" here - deviceId is just a hint, not a guarantee,
      // so unpaired/unidentified scans still fall back to activeStationId.
      window.electronAPI.barcode.scan(activeStationId, barcode, getLastRawInputDevice())
    },
    [activeStationId, getLastRawInputDevice]
  )
  useBarcodeListener(handleScan, true)

  // Number-key hotkeys let the operator switch the active station without a mouse.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      const index = Number(e.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < config.stations.length) {
        setActive(config.stations[index].id)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [config.stations, setActive])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-surface-800 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Packing Stations</h1>
          <p className="text-sm text-slate-500">
            Waiting for barcode... paired scanners route automatically, unpaired ones use the active
            station. Press 1-{config.stations.length} to switch.
          </p>
        </div>
        {updateAvailable && (
          <button
            onClick={() => setLaterForVersion(null)}
            className="text-xs font-medium px-3 py-1.5 rounded-full bg-accent-600/20 text-accent-500 hover:bg-accent-600/30"
          >
            Update available - v{updateState.latestVersion}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {config.stations.map((station, i) => (
            <StationPanel
              key={station.id}
              station={station}
              state={states[station.id]}
              overlayConfig={config.overlay}
              isActive={station.id === activeStationId}
              hotkey={i + 1}
              onSetActive={() => setActive(station.id)}
            />
          ))}
        </div>
      </div>

      {wrongBarcode && <WrongBarcodeToast event={wrongBarcode} />}
      {duplicateBarcode && <DuplicateBarcodeDialog event={duplicateBarcode} onClose={dismissDuplicateBarcode} />}
      {showUpdateModal && (
        <UpdateAvailableModal
          state={updateState}
          onDownload={() => window.electronAPI.update.download()}
          onInstall={() => window.electronAPI.update.install()}
          onLater={() => setLaterForVersion(updateState.latestVersion)}
        />
      )}
    </div>
  )
}
