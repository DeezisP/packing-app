import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RESOLUTION_PRESETS, buildCameraDisplayNames } from '../../electron/shared/types'
import { UpdatePanel } from '../components/common/UpdatePanel'
import { OverlayPreview } from '../components/common/OverlayPreview'
import { GlassPanel } from '../components/common/GlassPanel'
import { AnimatedButton } from '../components/common/AnimatedButton'
import { AnimatedDialog } from '../components/common/AnimatedDialog'
import { Toggle } from '../components/common/Toggle'
import { TestCameraModal } from '../components/pairing/TestCameraModal'
import { DiagnosticsPanel } from '../components/settings/DiagnosticsPanel'
import { useUpdateState } from '../hooks/useUpdateState'
import { useCameraDevices } from '../hooks/useCameraDevices'
import { formatBytes } from '../lib/format'
import { strings } from '../lib/strings'
import type {
  AppConfig,
  StationConfig,
  CameraDevice,
  ThemeMode,
  SaveLocationStatus,
  OverlayConfig
} from '../../electron/shared/types'

interface Props {
  config: AppConfig
  onConfigChanged: (config: AppConfig) => void
}

let stationCounter = 0
const T = strings.settings

export function SettingsPage({ config, onConfigChanged }: Props): JSX.Element {
  const { cameras, mics } = useCameraDevices()
  const [testCamera, setTestCamera] = useState<CameraDevice | null>(null)
  const [draft, setDraft] = useState<AppConfig>(config)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [backupMessage, setBackupMessage] = useState<string | null>(null)

  const [saveLocationInput, setSaveLocationInput] = useState(config.saveLocation)
  const [saveLocationValidation, setSaveLocationValidation] = useState<SaveLocationStatus | null>(null)
  const [saveLocationBusy, setSaveLocationBusy] = useState(false)
  const [pendingCreatePath, setPendingCreatePath] = useState<string | null>(null)
  const validationRequestId = useRef(0)

  const updateState = useUpdateState()
  const [previewNow, setPreviewNow] = useState(() => sampleClock())

  useEffect(() => setDraft(config), [config])
  useEffect(() => setSaveLocationInput(config.saveLocation), [config.saveLocation])

  // Keeps the overlay live-preview's date/time ticking, mirroring what the
  // real burned-in overlay does during an actual recording.
  useEffect(() => {
    const timer = window.setInterval(() => setPreviewNow(sampleClock()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Live-validate the drafted (not yet applied) save location as the user types.
  useEffect(() => {
    const requestId = ++validationRequestId.current
    const timer = window.setTimeout(async () => {
      const result = await window.electronAPI.config.validateSaveLocation(saveLocationInput)
      if (validationRequestId.current === requestId) setSaveLocationValidation(result)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [saveLocationInput])

  async function persist(next: AppConfig): Promise<void> {
    setDraft(next)
    setSaveState('saving')
    const saved = await window.electronAPI.config.update(next)
    onConfigChanged(saved)
    setSaveState('saved')
    window.setTimeout(() => setSaveState('idle'), 1500)
  }

  function updateStation(id: string, partial: Partial<StationConfig>): void {
    const stations = draft.stations.map((s) => {
      if (s.id === id) return { ...s, ...partial }
      // A physical camera can only ever belong to one station - assigning it
      // here un-assigns it from wherever it was before, the same way
      // assignScannerToStation (Device Pairing) already keeps scanner
      // assignments exclusive. Without this, two stations could silently
      // point at the same camera id and StationManager.resolveStationCamera
      // (which just returns the first live match) would make the second
      // station's assignment a no-op.
      if (partial.cameraId && s.cameraId === partial.cameraId) return { ...s, cameraId: null, cameraName: null }
      return s
    })
    persist({ ...draft, stations })
  }

  function moveStation(id: string, direction: -1 | 1): void {
    const index = draft.stations.findIndex((s) => s.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= draft.stations.length) return
    const stations = [...draft.stations]
    ;[stations[index], stations[target]] = [stations[target], stations[index]]
    persist({ ...draft, stations })
  }

  function updateOverlay(partial: Partial<OverlayConfig>): void {
    persist({ ...draft, overlay: { ...draft.overlay, ...partial } })
  }

  function addStation(): void {
    stationCounter += 1
    const newStation: StationConfig = {
      id: `station-${Date.now()}-${stationCounter}`,
      name: T.stationNumber(draft.stations.length + 1),
      enabled: true,
      cameraId: null,
      cameraName: null,
      micName: null,
      resolutionPreset: '1080p',
      fps: 30,
      bitrateKbps: 8000,
      scannerDeviceId: null,
      saveLocationOverride: null
    }
    persist({ ...draft, stations: [...draft.stations, newStation] })
  }

  function removeStation(id: string): void {
    if (draft.stations.length <= 1) return
    persist({ ...draft, stations: draft.stations.filter((s) => s.id !== id) })
  }

  async function pickSaveLocation(): Promise<void> {
    const folder = await window.electronAPI.config.pickFolder()
    if (!folder) return
    setSaveLocationInput(folder)
    // The native dialog only ever returns a folder that already exists, so
    // we just need to confirm it's actually writable before applying it.
    setSaveLocationBusy(true)
    const status = await window.electronAPI.config.validateSaveLocation(folder)
    setSaveLocationValidation(status)
    setSaveLocationBusy(false)
    if (status.writable) {
      await persist({ ...draft, saveLocation: folder })
    }
  }

  async function applySaveLocation(): Promise<void> {
    const target = saveLocationInput.trim()
    if (!target) return
    setSaveLocationBusy(true)
    const status = await window.electronAPI.config.validateSaveLocation(target)
    setSaveLocationValidation(status)
    setSaveLocationBusy(false)

    if (!status.exists) {
      setPendingCreatePath(target)
      return
    }
    if (status.writable) {
      await persist({ ...draft, saveLocation: target })
    }
  }

  async function confirmCreateFolder(): Promise<void> {
    if (!pendingCreatePath) return
    setSaveLocationBusy(true)
    const result = await window.electronAPI.config.createFolder(pendingCreatePath)
    if (result.success) {
      const status = await window.electronAPI.config.validateSaveLocation(pendingCreatePath)
      setSaveLocationValidation(status)
      if (status.writable) {
        await persist({ ...draft, saveLocation: pendingCreatePath })
      }
    } else {
      setSaveLocationValidation({
        path: pendingCreatePath,
        exists: false,
        writable: false,
        freeBytes: 0,
        totalBytes: 0,
        error: result.error ?? null
      })
    }
    setSaveLocationBusy(false)
    setPendingCreatePath(null)
  }

  async function resetSaveLocationToDefault(): Promise<void> {
    setSaveLocationBusy(true)
    const saved = await window.electronAPI.config.resetSaveLocation()
    onConfigChanged(saved)
    setSaveLocationInput(saved.saveLocation)
    const status = await window.electronAPI.config.validateSaveLocation(saved.saveLocation)
    setSaveLocationValidation(status)
    setSaveLocationBusy(false)
  }

  async function runBackup(): Promise<void> {
    const dest = await window.electronAPI.recordings.backupDatabase()
    setBackupMessage(T.backupCreated(dest))
    window.setTimeout(() => setBackupMessage(null), 5000)
  }

  const cameraDisplayNames = useMemo(() => buildCameraDisplayNames(cameras), [cameras])

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{T.title}</h1>
          <p className="text-sm text-slate-500">{T.subtitle}</p>
        </div>
        <SaveIndicator state={saveState} />
      </header>

      <Section title={T.sectionGeneral}>
        <Field label={T.currentSaveLocation}>
          <div className="flex gap-2">
            <input
              value={saveLocationInput}
              onChange={(e) => setSaveLocationInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySaveLocation()
              }}
              placeholder={T.saveLocationPlaceholder}
              className="flex-1 bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono focus:outline-none focus:ring-1 focus:ring-accent-500 transition-shadow"
            />
            <AnimatedButton onClick={pickSaveLocation} disabled={saveLocationBusy}>
              {strings.common.browse}
            </AnimatedButton>
            <AnimatedButton
              variant="primary"
              onClick={applySaveLocation}
              disabled={saveLocationBusy || saveLocationInput.trim() === draft.saveLocation}
            >
              {strings.common.apply}
            </AnimatedButton>
            <AnimatedButton onClick={resetSaveLocationToDefault} disabled={saveLocationBusy}>
              {T.resetToDefault}
            </AnimatedButton>
          </div>

          <SaveLocationStatusLine status={saveLocationValidation} busy={saveLocationBusy} />

          {saveLocationInput.trim() !== draft.saveLocation && (
            <p className="text-xs text-warn-500 mt-1">{T.unsavedPath}</p>
          )}
        </Field>

        <AnimatePresence>
          {pendingCreatePath && (
            <CreateFolderConfirmDialog
              key="create-folder"
              targetPath={pendingCreatePath}
              onConfirm={confirmCreateFolder}
              onCancel={() => setPendingCreatePath(null)}
            />
          )}
        </AnimatePresence>

        <div className="grid grid-cols-2 gap-6 mt-6">
          <Field label={T.theme}>
            <select
              value={draft.theme}
              onChange={(e) => persist({ ...draft, theme: e.target.value as ThemeMode })}
              className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
            >
              <option value="dark">{T.themeDark}</option>
              <option value="light">{T.themeLight}</option>
            </select>
          </Field>

          <Field label={T.autoStart}>
            <Toggle checked={draft.autoStartWindows} onChange={(v) => persist({ ...draft, autoStartWindows: v })} />
          </Field>

          <Field label={T.autoBackup}>
            <div className="flex items-center gap-3">
              <Toggle checked={draft.dbBackupEnabled} onChange={(v) => persist({ ...draft, dbBackupEnabled: v })} />
              <AnimatedButton size="sm" onClick={runBackup}>
                {T.backupNow}
              </AnimatedButton>
            </div>
          </Field>
        </div>
        {backupMessage && <p className="text-xs text-ok-500 mt-2">{backupMessage}</p>}
      </Section>

      <Section title={T.sectionUpdates}>
        <UpdatePanel
          state={updateState}
          onCheck={() => window.electronAPI.update.check()}
          onDownload={() => window.electronAPI.update.download()}
          onInstall={() => window.electronAPI.update.install()}
        />
      </Section>

      <Section
        title={T.sectionStations}
        action={
          <AnimatedButton variant="ghost" size="sm" onClick={addStation}>
            {T.addStation}
          </AnimatedButton>
        }
      >
        <div className="space-y-4">
          <AnimatePresence initial={false}>
            {draft.stations.map((station, index) => (
              <StationSettingsCard
                key={station.id}
                station={station}
                cameras={cameras}
                cameraDisplayNames={cameraDisplayNames}
                mics={mics}
                onChange={(partial) => updateStation(station.id, partial)}
                onRemove={() => removeStation(station.id)}
                onMoveUp={index > 0 ? () => moveStation(station.id, -1) : undefined}
                onMoveDown={index < draft.stations.length - 1 ? () => moveStation(station.id, 1) : undefined}
                removable={draft.stations.length > 1}
              />
            ))}
          </AnimatePresence>
        </div>
      </Section>

      <Section title={strings.diagnostics.sectionTitle}>
        <DiagnosticsPanel
          cameras={cameras}
          cameraDisplayNames={cameraDisplayNames}
          stations={draft.stations}
          onTestCamera={setTestCamera}
        />
      </Section>

      <Section title={T.sectionOverlay}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <Field label={T.enableOverlay}>
              <Toggle checked={draft.overlay.enabled} onChange={(v) => updateOverlay({ enabled: v })} />
            </Field>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {(
                [
                  ['showBarcode', T.showBarcode],
                  ['showDate', T.showDate],
                  ['showTime', T.showTime],
                  ['showTimer', T.showTimer],
                  ['showStation', T.showStation],
                  ['showCamera', T.showCamera]
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between text-sm py-1">
                  <span className="text-slate-400">{label}</span>
                  <Toggle checked={draft.overlay[key]} onChange={(v) => updateOverlay({ [key]: v })} />
                </label>
              ))}
            </div>

            <Field label={T.overlayPosition}>
              <select
                value={draft.overlay.position}
                onChange={(e) => updateOverlay({ position: e.target.value as OverlayConfig['position'] })}
                className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
              >
                <option value="top-left">{T.posTopLeft}</option>
                <option value="top-right">{T.posTopRight}</option>
                <option value="bottom-left">{T.posBottomLeft}</option>
                <option value="bottom-right">{T.posBottomRight}</option>
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label={T.fontSize}>
                <input
                  type="number"
                  min={10}
                  max={72}
                  value={draft.overlay.fontSize}
                  onChange={(e) => updateOverlay({ fontSize: Number(e.target.value) })}
                  className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm"
                />
              </Field>
              <Field label={T.backgroundOpacity}>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draft.overlay.backgroundOpacity}
                    onChange={(e) => updateOverlay({ backgroundOpacity: Number(e.target.value) })}
                    className="w-full accent-accent-500"
                  />
                  <span className="text-xs text-slate-400 w-10 text-right">{draft.overlay.backgroundOpacity}%</span>
                </div>
              </Field>
              <Field label={T.fontColor}>
                <input
                  type="color"
                  value={draft.overlay.fontColor}
                  onChange={(e) => updateOverlay({ fontColor: e.target.value })}
                  className="w-full h-9 bg-surface-800/60 border border-white/10 rounded-lg cursor-pointer"
                />
              </Field>
              <Field label={T.backgroundColor}>
                <input
                  type="color"
                  value={draft.overlay.backgroundColor}
                  onChange={(e) => updateOverlay({ backgroundColor: e.target.value })}
                  className="w-full h-9 bg-surface-800/60 border border-white/10 rounded-lg cursor-pointer"
                />
              </Field>
            </div>
          </div>

          <div>
            <span className="block text-xs text-slate-500 mb-1">{T.livePreview}</span>
            <div className="relative aspect-video bg-surface-950 rounded-xl overflow-hidden border border-white/10">
              <OverlayPreview
                config={draft.overlay}
                data={{
                  barcode: 'ORD240715001',
                  date: previewNow.date,
                  time: previewNow.time,
                  timer: '00:02:45',
                  station: draft.stations[0]?.name ?? T.stationNumber(1),
                  camera: draft.stations[0]?.cameraName ?? 'EMEET S600 #1'
                }}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title={T.sectionScannerAssignment}>
        <p className="text-sm text-slate-400">{T.scannerAssignmentBody(Math.min(draft.stations.length, 9))}</p>
        <div className="mt-4 space-y-2 text-sm">
          {draft.stations.map((station) => (
            <div key={station.id} className="flex items-center justify-between">
              <span className="text-slate-500">{station.name}</span>
              <span className="text-slate-300 font-mono text-xs">{station.scannerDeviceId ?? strings.common.notPaired}</span>
            </div>
          ))}
        </div>
      </Section>

      <AnimatePresence>
        {testCamera && (
          <TestCameraModal
            key="test-camera"
            camera={testCamera}
            cameras={cameras}
            onClose={() => setTestCamera(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function StationSettingsCard({
  station,
  cameras,
  cameraDisplayNames,
  mics,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  removable
}: {
  station: StationConfig
  cameras: CameraDevice[]
  cameraDisplayNames: Map<string, string>
  mics: string[]
  onChange: (partial: Partial<StationConfig>) => void
  onRemove: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  removable: boolean
}): JSX.Element {
  const usesGlobalSaveLocation = station.saveLocationOverride === null

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={`border border-white/10 rounded-xl p-4 bg-surface-850/30 transition-opacity ${
        station.enabled ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col gap-0.5 shrink-0">
            <button
              onClick={onMoveUp}
              disabled={!onMoveUp}
              className="text-slate-500 hover:text-slate-200 disabled:opacity-25 disabled:hover:text-slate-500 text-xs leading-none"
              title={strings.settings.moveUp}
            >
              ▲
            </button>
            <button
              onClick={onMoveDown}
              disabled={!onMoveDown}
              className="text-slate-500 hover:text-slate-200 disabled:opacity-25 disabled:hover:text-slate-500 text-xs leading-none"
              title={strings.settings.moveDown}
            >
              ▼
            </button>
          </div>
          <input
            value={station.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="bg-transparent text-sm font-semibold text-slate-100 border-b border-transparent focus:border-white/20 outline-none min-w-0"
          />
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            {strings.settings.enableStation}
            <Toggle checked={station.enabled} onChange={(v) => onChange({ enabled: v })} />
          </label>
          {removable && (
            <button onClick={onRemove} className="text-xs text-rec-500 hover:text-rec-400">
              {strings.common.remove}
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Field label={strings.stationCard.camera}>
          <select
            value={station.cameraId ?? ''}
            onChange={(e) => {
              const id = e.target.value || null
              const camera = cameras.find((c) => c.id === id)
              onChange({ cameraId: id, cameraName: camera?.name ?? null })
            }}
            className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
          >
            <option value="">{strings.common.notAssigned}</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {cameraDisplayNames.get(c.id) ?? c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={strings.settings.microphone}>
          <select
            value={station.micName ?? ''}
            onChange={(e) => onChange({ micName: e.target.value || null })}
            className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
          >
            <option value="">{strings.settings.micNone}</option>
            {mics.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label={strings.settings.resolution}>
          <select
            value={station.resolutionPreset}
            onChange={(e) => onChange({ resolutionPreset: e.target.value as StationConfig['resolutionPreset'] })}
            className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
          >
            {Object.keys(RESOLUTION_PRESETS).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </Field>

        <Field label={strings.settings.fps}>
          <select
            value={station.fps}
            onChange={(e) => onChange({ fps: Number(e.target.value) })}
            className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
          >
            {[24, 30, 60].map((fps) => (
              <option key={fps} value={fps}>
                {fps}
              </option>
            ))}
          </select>
        </Field>

        <Field label={strings.settings.bitrate}>
          <input
            type="number"
            min={1000}
            max={50000}
            step={500}
            value={station.bitrateKbps}
            onChange={(e) => onChange({ bitrateKbps: Number(e.target.value) })}
            className="w-full bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
          />
        </Field>

        <div className="col-span-2 md:col-span-4">
          <span className="block text-xs text-slate-500 mb-1">{strings.settings.saveLocationOverride}</span>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
              {strings.settings.useGlobalSaveLocation}
              <Toggle
                checked={usesGlobalSaveLocation}
                onChange={(v) => onChange({ saveLocationOverride: v ? null : '' })}
              />
            </label>
            {!usesGlobalSaveLocation && (
              <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                <input
                  value={station.saveLocationOverride ?? ''}
                  onChange={(e) => onChange({ saveLocationOverride: e.target.value })}
                  placeholder={strings.settings.customSaveLocationPlaceholder}
                  className="flex-1 bg-surface-800/60 border border-white/10 rounded-lg px-2 py-1.5 text-sm font-mono"
                />
                <AnimatedButton
                  size="sm"
                  onClick={async () => {
                    const folder = await window.electronAPI.config.pickFolder()
                    if (folder) onChange({ saveLocationOverride: folder })
                  }}
                >
                  {strings.common.browse}
                </AnimatedButton>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function sampleClock(): { date: string; time: string } {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }
}

function SaveLocationStatusLine({
  status,
  busy
}: {
  status: SaveLocationStatus | null
  busy: boolean
}): JSX.Element {
  if (busy) return <p className="text-xs text-slate-500 mt-2">{T.checkingFolder}</p>
  if (!status) return <p className="text-xs text-slate-500 mt-2">-</p>

  if (!status.exists) {
    return <p className="text-xs text-rec-500 mt-2">{T.folderNotExist}</p>
  }
  if (!status.writable) {
    return <p className="text-xs text-rec-500 mt-2">{status.error ?? T.folderNotWritable}</p>
  }
  return (
    <p className="text-xs text-ok-500 mt-2">{T.folderWritable(formatBytes(status.freeBytes), formatBytes(status.totalBytes))}</p>
  )
}

function CreateFolderConfirmDialog({
  targetPath,
  onConfirm,
  onCancel
}: {
  targetPath: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <AnimatedDialog onClose={onCancel}>
      <h2 className="text-lg font-semibold text-slate-100">{T.folderDoesNotExistTitle}</h2>
      <p className="text-sm text-slate-400 mt-2">{T.folderDoesNotExistBody(targetPath)}</p>
      <div className="flex justify-end gap-3 mt-6">
        <AnimatedButton onClick={onCancel}>{strings.common.no}</AnimatedButton>
        <AnimatedButton variant="primary" onClick={onConfirm}>
          {T.createIt}
        </AnimatedButton>
      </div>
    </AnimatedDialog>
  )
}

function Section({
  title,
  action,
  children
}: {
  title: string
  action?: JSX.Element
  children: React.ReactNode
}): JSX.Element {
  return (
    <GlassPanel className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
        {action}
      </div>
      {children}
    </GlassPanel>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  )
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' }): JSX.Element | null {
  if (state === 'idle') return null
  return <span className="text-xs text-slate-500">{state === 'saving' ? T.saving : T.saved}</span>
}
