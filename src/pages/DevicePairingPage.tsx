import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { TestCameraModal } from '../components/pairing/TestCameraModal'
import { GlassPanel } from '../components/common/GlassPanel'
import { AnimatedButton } from '../components/common/AnimatedButton'
import { useBarcodeListener } from '../hooks/useBarcodeListener'
import { useRawInputDevice } from '../hooks/useRawInputDevice'
import { strings } from '../lib/strings'
import type { AppConfig, CameraDevice, IdentifiedScanner, ScannerDevice } from '../../electron/shared/types'

interface Props {
  config: AppConfig
  onConfigChanged: (config: AppConfig) => void
}

const IDENTIFY_TIMEOUT_MS = 15000
const T = strings.devicePairing

export function DevicePairingPage({ config, onConfigChanged }: Props): JSX.Element {
  const [rawScanners, setRawScanners] = useState<ScannerDevice[]>([])
  const [cameras, setCameras] = useState<CameraDevice[]>([])
  const [testCamera, setTestCamera] = useState<string | null>(null)

  const [identifying, setIdentifying] = useState(false)
  const [identifyError, setIdentifyError] = useState<string | null>(null)
  const [pendingIdentify, setPendingIdentify] = useState<{ id: string; nameDraft: string; isRename: boolean } | null>(
    null
  )
  const [advancedId, setAdvancedId] = useState<string | null>(null)

  const getLastRawInputDevice = useRawInputDevice()

  useEffect(() => {
    refreshScanners()
    refreshCameras()
    const offScanners = window.electronAPI.scanners.onListChanged(setRawScanners)
    const offCameras = window.electronAPI.cameras.onListChanged(({ video }) => setCameras(video))
    return () => {
      offScanners()
      offCameras()
    }
  }, [])

  useEffect(() => {
    if (!identifying) return
    const timer = window.setTimeout(() => {
      setIdentifying(false)
      setIdentifyError(T.identifyTimeout)
    }, IDENTIFY_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [identifying])

  async function refreshScanners(): Promise<void> {
    setRawScanners(await window.electronAPI.scanners.list())
  }

  async function refreshCameras(): Promise<void> {
    const { video } = await window.electronAPI.cameras.list()
    setCameras(video)
  }

  // Only active while "identifying" - this page otherwise never intercepts
  // keystrokes, so normal Dashboard scanning is completely unaffected.
  useBarcodeListener(() => {
    if (!identifying) return
    const deviceId = getLastRawInputDevice()
    setIdentifying(false)
    if (!deviceId) {
      setIdentifyError(T.rawInputUnavailable)
      return
    }
    const existing = config.identifiedScanners.find((s) => s.id === deviceId)
    const rawMatch = rawScanners.find((s) => s.id === deviceId)
    setPendingIdentify({
      id: deviceId,
      nameDraft: existing?.name ?? rawMatch?.name ?? strings.settings.stationNumber(config.identifiedScanners.length + 1),
      isRename: Boolean(existing)
    })
  }, identifying)

  function startIdentify(): void {
    setIdentifyError(null)
    setPendingIdentify(null)
    setIdentifying(true)
  }

  async function confirmIdentify(): Promise<void> {
    if (!pendingIdentify) return
    const name = pendingIdentify.nameDraft.trim()
    if (!name) return
    const withoutExisting = config.identifiedScanners.filter((s) => s.id !== pendingIdentify.id)
    const identifiedScanners: IdentifiedScanner[] = [...withoutExisting, { id: pendingIdentify.id, name }]
    const saved = await window.electronAPI.config.update({ identifiedScanners })
    onConfigChanged(saved)
    setPendingIdentify(null)
    refreshScanners()
  }

  async function renameScanner(id: string, name: string): Promise<void> {
    if (!name.trim()) return
    const identifiedScanners = config.identifiedScanners.map((s) => (s.id === id ? { ...s, name: name.trim() } : s))
    const saved = await window.electronAPI.config.update({ identifiedScanners })
    onConfigChanged(saved)
  }

  async function removeScanner(id: string): Promise<void> {
    const identifiedScanners = config.identifiedScanners.filter((s) => s.id !== id)
    const stations = config.stations.map((s) => (s.scannerDeviceId === id ? { ...s, scannerDeviceId: null } : s))
    const saved = await window.electronAPI.config.update({ identifiedScanners, stations })
    onConfigChanged(saved)
  }

  async function assignScannerToStation(scannerId: string, stationId: string | null): Promise<void> {
    const stations = config.stations.map((s) => {
      if (s.id === stationId) return { ...s, scannerDeviceId: scannerId }
      if (s.scannerDeviceId === scannerId) return { ...s, scannerDeviceId: null }
      return s
    })
    const saved = await window.electronAPI.config.update({ stations })
    onConfigChanged(saved)
  }

  function stationForScanner(scannerId: string): string {
    return config.stations.find((s) => s.scannerDeviceId === scannerId)?.id ?? ''
  }

  const connectedById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const s of rawScanners) map.set(s.id, s.connected)
    return map
  }, [rawScanners])

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{T.title}</h1>
          <p className="text-sm text-slate-500">{T.subtitle}</p>
        </div>
        <AnimatedButton variant="primary" onClick={startIdentify} disabled={identifying}>
          {identifying ? T.scanningNow : T.identifyScanner}
        </AnimatedButton>
      </header>

      <AnimatePresence>
        {identifying && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-accent-600/10 border border-accent-600/40 text-accent-500 text-sm rounded-xl px-4 py-3 flex items-center justify-between overflow-hidden"
          >
            <span>{T.waitingBanner}</span>
            <button onClick={() => setIdentifying(false)} className="text-slate-300 hover:text-slate-100 text-xs underline">
              {strings.common.cancel}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {identifyError && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="bg-warn-500/10 border border-warn-500/40 text-warn-500 text-sm rounded-xl px-4 py-3"
          >
            {identifyError}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {pendingIdentify && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="bg-ok-500/10 border border-ok-500/40 rounded-xl px-4 py-3 flex items-center gap-3"
          >
            <span className="text-ok-500 text-sm">{pendingIdentify.isRename ? T.renamePrompt : T.newScannerPrompt}</span>
            <input
              autoFocus
              value={pendingIdentify.nameDraft}
              onChange={(e) => setPendingIdentify({ ...pendingIdentify, nameDraft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmIdentify()
              }}
              placeholder={T.namePlaceholder}
              className="flex-1 bg-surface-800/60 border border-white/10 rounded-lg px-3 py-1.5 text-sm"
            />
            <AnimatedButton variant="success" size="sm" onClick={confirmIdentify}>
              {strings.common.save}
            </AnimatedButton>
            <button onClick={() => setPendingIdentify(null)} className="text-slate-400 hover:text-slate-200 text-sm">
              {strings.common.cancel}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="space-y-4">
        {config.identifiedScanners.length === 0 && !identifying && (
          <GlassPanel className="p-8 text-center text-slate-500 text-sm">{T.emptyState}</GlassPanel>
        )}

        <AnimatePresence initial={false}>
          {config.identifiedScanners.map((scanner) => {
            const connected = connectedById.get(scanner.id) ?? false
            const stationId = stationForScanner(scanner.id)
            const station = config.stations.find((s) => s.id === stationId)
            return (
              <GlassPanel key={scanner.id} layout className="p-5">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-3">
                    <span className={`text-lg ${connected ? 'text-ok-500' : 'text-rec-500'}`}>{connected ? '✓' : '✕'}</span>
                    <div>
                      <input
                        value={scanner.name}
                        onChange={(e) => renameScanner(scanner.id, e.target.value)}
                        className="bg-transparent text-sm font-semibold text-slate-100 border-b border-transparent focus:border-white/20 outline-none"
                      />
                      <div className="text-xs text-slate-500 mt-0.5">
                        {T.scannerLabel} -{' '}
                        <span className={connected ? 'text-ok-500' : 'text-rec-500'}>
                          {connected ? strings.common.connected : strings.common.disconnected}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-slate-500">{T.station}</span>
                      <select
                        value={stationId}
                        onChange={(e) => assignScannerToStation(scanner.id, e.target.value || null)}
                        className="bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
                      >
                        <option value="">{strings.common.notAssigned}</option>
                        {config.stations.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <span className="text-sm text-slate-500">{T.camera(station?.cameraName ?? strings.common.none)}</span>

                    <button
                      onClick={() => setAdvancedId(advancedId === scanner.id ? null : scanner.id)}
                      className="text-xs text-slate-500 hover:text-slate-300 underline"
                    >
                      {T.advanced}
                    </button>
                    <button onClick={() => removeScanner(scanner.id)} className="text-xs text-rec-500 hover:text-rec-400">
                      {strings.common.remove}
                    </button>
                  </div>
                </div>

                <AnimatePresence>
                  {advancedId === scanner.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-3 pt-3 border-t border-white/10 text-xs text-slate-500 font-mono overflow-hidden"
                    >
                      {T.instanceId(scanner.id)}
                    </motion.div>
                  )}
                </AnimatePresence>
              </GlassPanel>
            )
          })}
        </AnimatePresence>
      </section>

      <Section title={T.sectionCameras}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">{strings.common.name}</th>
                <th className="text-left px-3 py-2">{strings.common.status}</th>
                <th className="text-left px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((camera) => (
                <tr key={camera.name} className="border-t border-white/5">
                  <td className="px-3 py-2 text-slate-200">{camera.name}</td>
                  <td className="px-3 py-2">
                    <span className={camera.connected ? 'text-ok-500' : 'text-rec-500'}>
                      {camera.connected ? strings.common.connected : strings.common.disconnected}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <AnimatedButton size="sm" onClick={() => setTestCamera(camera.name)}>
                      {T.testCamera}
                    </AnimatedButton>
                  </td>
                </tr>
              ))}
              {cameras.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center text-slate-600">
                    {T.noCamerasDetected}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <AnimatePresence>
        {testCamera && <TestCameraModal key="test-camera" cameraName={testCamera} onClose={() => setTestCamera(null)} />}
      </AnimatePresence>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <GlassPanel className="p-5">
      <h2 className="text-sm font-semibold text-slate-200 mb-4">{title}</h2>
      {children}
    </GlassPanel>
  )
}
