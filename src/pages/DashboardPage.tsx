import { useEffect, useState, useCallback, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { StationCard } from '../components/dashboard/StationCard'
import { WrongBarcodeToast } from '../components/dashboard/WrongBarcodeToast'
import { DuplicateBarcodeDialog } from '../components/dashboard/DuplicateBarcodeDialog'
import { UpdateAvailableModal } from '../components/dashboard/UpdateAvailableModal'
import { GlassPanel } from '../components/common/GlassPanel'
import { NotificationToast } from '../components/common/NotificationToast'
import { useBarcodeListener } from '../hooks/useBarcodeListener'
import { useStationsState } from '../hooks/useStationsState'
import { useUpdateState } from '../hooks/useUpdateState'
import { useRawInputDevice } from '../hooks/useRawInputDevice'
import { useCameraDevices } from '../hooks/useCameraDevices'
import { strings } from '../lib/strings'
import type { AppConfig } from '../../electron/shared/types'

interface Props {
  config: AppConfig
  onConfigChanged: (config: AppConfig) => void
}

export function DashboardPage({ config, onConfigChanged }: Props): JSX.Element {
  const { states, wrongBarcode, duplicateBarcode, dismissDuplicateBarcode } = useStationsState()
  const { cameras } = useCameraDevices()
  const [activeStationId, setActiveStationId] = useState(config.activeStationId)
  const updateState = useUpdateState()
  const [laterForVersion, setLaterForVersion] = useState<string | null>(null)

  const updateAvailable = updateState.status === 'available' || updateState.status === 'downloaded'
  const showUpdateModal = updateAvailable && laterForVersion !== updateState.latestVersion

  const [apiWarning, setApiWarning] = useState<string | null>(null)
  useEffect(() => {
    // Recording never depends on this - the warehouse API sync runs in the
    // background and retries on its own (see ApiQueueService). This only
    // ever tells the operator "the last attempt failed, still trying" - it
    // never blocks or interrupts anything on screen.
    let previousError: string | null = null
    const off = window.electronAPI.apiQueue.onStatusChanged((status) => {
      if (status.lastError && !previousError) {
        setApiWarning(strings.dashboard.warehouseApiUnavailable)
        window.setTimeout(() => setApiWarning(null), 6000)
      }
      previousError = status.lastError
    })
    return off
  }, [])

  // Disabled stations stay configured (Settings can re-enable them) but never
  // render or accept scans - the grid below is sized purely off this list,
  // so it scales to any number of enabled stations without special-casing.
  const enabledStations = useMemo(() => config.stations.filter((s) => s.enabled), [config.stations])

  useEffect(() => setActiveStationId(config.activeStationId), [config.activeStationId])

  const setActive = useCallback(
    (stationId: string) => {
      setActiveStationId(stationId)
      window.electronAPI.stations.setActive(stationId)
      window.electronAPI.config.get().then(onConfigChanged)
    },
    [onConfigChanged]
  )

  // If the active station gets disabled or removed in Settings, fall back to
  // the first still-enabled one so unpaired scans always have somewhere to
  // go instead of silently hitting a disabled station and doing nothing.
  useEffect(() => {
    if (enabledStations.length === 0) return
    if (enabledStations.some((s) => s.id === activeStationId)) return
    setActive(enabledStations[0].id)
  }, [enabledStations, activeStationId, setActive])

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

  // Number-key hotkeys let the operator switch the active station without a
  // mouse - limited to the first 9 enabled stations since that's as far as a
  // single digit key can reach; clicking a card always works regardless of count.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      const index = Number(e.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < enabledStations.length) {
        setActive(enabledStations[index].id)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [enabledStations, setActive])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{strings.dashboard.title}</h1>
          <p className="text-sm text-slate-500">{strings.dashboard.subtitle(Math.min(enabledStations.length, 9))}</p>
        </div>
        {updateAvailable && (
          <motion.button
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => setLaterForVersion(null)}
            className="text-xs font-medium px-3 py-1.5 rounded-full bg-accent-600/20 text-accent-500 hover:bg-accent-600/30"
          >
            {strings.dashboard.updateAvailable(updateState.latestVersion ?? '')}
          </motion.button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {enabledStations.length === 0 ? (
          <GlassPanel className="p-8 text-center text-sm text-slate-500">
            {strings.dashboard.noEnabledStations}
          </GlassPanel>
        ) : (
          <div
            className="grid gap-6"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}
          >
            <AnimatePresence initial={false}>
              {enabledStations.map((station, i) => (
                <StationCard
                  key={station.id}
                  station={station}
                  state={states[station.id]}
                  cameras={cameras}
                  isActive={station.id === activeStationId}
                  hotkey={i + 1}
                  onSetActive={() => setActive(station.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <AnimatePresence>{wrongBarcode && <WrongBarcodeToast key="wrong-barcode" event={wrongBarcode} />}</AnimatePresence>
      <AnimatePresence>
        {apiWarning && (
          <NotificationToast key="api-warning" tone="warning" title={apiWarning} onDismiss={() => setApiWarning(null)}>
            {strings.dashboard.warehouseApiUnavailableBody}
          </NotificationToast>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {duplicateBarcode && (
          <DuplicateBarcodeDialog key="duplicate-barcode" event={duplicateBarcode} onClose={dismissDuplicateBarcode} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showUpdateModal && (
          <UpdateAvailableModal
            key="update-available"
            state={updateState}
            onDownload={() => window.electronAPI.update.download()}
            onInstall={() => window.electronAPI.update.install()}
            onLater={() => setLaterForVersion(updateState.latestVersion)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
