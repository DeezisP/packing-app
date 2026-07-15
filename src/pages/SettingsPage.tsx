import { useEffect, useRef, useState } from 'react'
import { RESOLUTION_PRESETS } from '../../electron/shared/types'
import { UpdatePanel } from '../components/common/UpdatePanel'
import { OverlayPreview } from '../components/common/OverlayPreview'
import { useUpdateState } from '../hooks/useUpdateState'
import { formatBytes } from '../lib/format'
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

export function SettingsPage({ config, onConfigChanged }: Props): JSX.Element {
  const [cameras, setCameras] = useState<CameraDevice[]>([])
  const [mics, setMics] = useState<string[]>([])
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

  useEffect(() => {
    refreshCameras()
    const off = window.electronAPI.cameras.onListChanged(({ video, audio }) => {
      setCameras(video)
      setMics(audio)
    })
    return off
  }, [])

  async function refreshCameras(): Promise<void> {
    const { video, audio } = await window.electronAPI.cameras.list()
    setCameras(video)
    setMics(audio)
  }

  async function persist(next: AppConfig): Promise<void> {
    setDraft(next)
    setSaveState('saving')
    const saved = await window.electronAPI.config.update(next)
    onConfigChanged(saved)
    setSaveState('saved')
    window.setTimeout(() => setSaveState('idle'), 1500)
  }

  function updateStation(id: string, partial: Partial<StationConfig>): void {
    const stations = draft.stations.map((s) => (s.id === id ? { ...s, ...partial } : s))
    persist({ ...draft, stations })
  }

  function updateOverlay(partial: Partial<OverlayConfig>): void {
    persist({ ...draft, overlay: { ...draft.overlay, ...partial } })
  }

  function addStation(): void {
    stationCounter += 1
    const newStation: StationConfig = {
      id: `station-${Date.now()}-${stationCounter}`,
      name: `Packing Station ${String.fromCharCode(65 + draft.stations.length)}`,
      cameraName: null,
      micName: null,
      resolutionPreset: '1080p',
      fps: 30,
      bitrateKbps: 8000,
      scannerDeviceId: null
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
        error: result.error ?? 'Failed to create folder.'
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
    setBackupMessage(`Backup created: ${dest}`)
    window.setTimeout(() => setBackupMessage(null), 5000)
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
          <p className="text-sm text-slate-500">Changes save automatically.</p>
        </div>
        <SaveIndicator state={saveState} />
      </header>

      <Section title="General">
        <Field label="Current save location">
          <div className="flex gap-2">
            <input
              value={saveLocationInput}
              onChange={(e) => setSaveLocationInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySaveLocation()
              }}
              placeholder="e.g. D:\PackingVideos"
              className="flex-1 bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono"
            />
            <button
              onClick={pickSaveLocation}
              disabled={saveLocationBusy}
              className="px-3 py-2 rounded-lg text-sm bg-surface-700 hover:bg-surface-600 disabled:opacity-50"
            >
              Browse...
            </button>
            <button
              onClick={applySaveLocation}
              disabled={saveLocationBusy || saveLocationInput.trim() === draft.saveLocation}
              className="px-3 py-2 rounded-lg text-sm bg-accent-600 hover:bg-accent-500 text-white disabled:opacity-50"
            >
              Apply
            </button>
            <button
              onClick={resetSaveLocationToDefault}
              disabled={saveLocationBusy}
              className="px-3 py-2 rounded-lg text-sm bg-surface-700 hover:bg-surface-600 disabled:opacity-50"
            >
              Reset to default
            </button>
          </div>

          <SaveLocationStatusLine status={saveLocationValidation} busy={saveLocationBusy} />

          {saveLocationInput.trim() !== draft.saveLocation && (
            <p className="text-xs text-warn-500 mt-1">Unsaved path - click Apply (or press Enter) to use it.</p>
          )}
        </Field>

        {pendingCreatePath && (
          <CreateFolderConfirmDialog
            targetPath={pendingCreatePath}
            onConfirm={confirmCreateFolder}
            onCancel={() => setPendingCreatePath(null)}
          />
        )}

        <div className="grid grid-cols-2 gap-6 mt-6">
          <Field label="Theme">
            <select
              value={draft.theme}
              onChange={(e) => persist({ ...draft, theme: e.target.value as ThemeMode })}
              className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </Field>

          <Field label="Auto start with Windows">
            <Toggle
              checked={draft.autoStartWindows}
              onChange={(v) => persist({ ...draft, autoStartWindows: v })}
            />
          </Field>

          <Field label="Automatic database backup">
            <div className="flex items-center gap-3">
              <Toggle checked={draft.dbBackupEnabled} onChange={(v) => persist({ ...draft, dbBackupEnabled: v })} />
              <button onClick={runBackup} className="text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600">
                Backup now
              </button>
            </div>
          </Field>
        </div>
        {backupMessage && <p className="text-xs text-ok-500 mt-2">{backupMessage}</p>}
      </Section>

      <Section title="Updates">
        <UpdatePanel
          state={updateState}
          onCheck={() => window.electronAPI.update.check()}
          onDownload={() => window.electronAPI.update.download()}
          onInstall={() => window.electronAPI.update.install()}
        />
      </Section>

      <Section title="Packing Stations" action={<button onClick={addStation} className="text-sm text-accent-500 hover:text-accent-600">+ Add station</button>}>
        <div className="space-y-4">
          {draft.stations.map((station) => (
            <StationSettingsCard
              key={station.id}
              station={station}
              cameras={cameras}
              mics={mics}
              onChange={(partial) => updateStation(station.id, partial)}
              onRemove={() => removeStation(station.id)}
              removable={draft.stations.length > 1}
            />
          ))}
        </div>
      </Section>

      <Section title="Recording Overlay">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <Field label="Enable Overlay">
              <Toggle checked={draft.overlay.enabled} onChange={(v) => updateOverlay({ enabled: v })} />
            </Field>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {(
                [
                  ['showBarcode', 'Show Barcode'],
                  ['showDate', 'Show Date'],
                  ['showTime', 'Show Current Time'],
                  ['showTimer', 'Show Recording Timer'],
                  ['showStation', 'Show Packing Station'],
                  ['showCamera', 'Show Camera Name']
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between text-sm py-1">
                  <span className="text-slate-400">{label}</span>
                  <Toggle checked={draft.overlay[key]} onChange={(v) => updateOverlay({ [key]: v })} />
                </label>
              ))}
            </div>

            <Field label="Overlay Position">
              <select
                value={draft.overlay.position}
                onChange={(e) => updateOverlay({ position: e.target.value as OverlayConfig['position'] })}
                className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
              >
                <option value="top-left">Top Left</option>
                <option value="top-right">Top Right</option>
                <option value="bottom-left">Bottom Left</option>
                <option value="bottom-right">Bottom Right</option>
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Font Size">
                <input
                  type="number"
                  min={10}
                  max={72}
                  value={draft.overlay.fontSize}
                  onChange={(e) => updateOverlay({ fontSize: Number(e.target.value) })}
                  className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Background Opacity">
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
              <Field label="Font Color">
                <input
                  type="color"
                  value={draft.overlay.fontColor}
                  onChange={(e) => updateOverlay({ fontColor: e.target.value })}
                  className="w-full h-9 bg-surface-800 border border-surface-600 rounded-lg cursor-pointer"
                />
              </Field>
              <Field label="Background Color">
                <input
                  type="color"
                  value={draft.overlay.backgroundColor}
                  onChange={(e) => updateOverlay({ backgroundColor: e.target.value })}
                  className="w-full h-9 bg-surface-800 border border-surface-600 rounded-lg cursor-pointer"
                />
              </Field>
            </div>
          </div>

          <div>
            <span className="block text-xs text-slate-500 mb-1">Live Preview</span>
            <div className="relative aspect-video bg-surface-950 rounded-lg overflow-hidden border border-surface-700">
              <OverlayPreview
                config={draft.overlay}
                data={{
                  barcode: 'ORD240715001',
                  date: previewNow.date,
                  time: previewNow.time,
                  timer: '00:02:45',
                  station: draft.stations[0]?.name ?? 'Packing Station 1',
                  camera: draft.stations[0]?.cameraName ?? 'EMEET S600 #1'
                }}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Scanner assignment">
        <p className="text-sm text-slate-400">
          Pair physical scanners to stations from the <span className="text-slate-200">Device Pairing</span> tab -
          it identifies each USB scanner individually (via Windows Raw Input) and lets you assign it with a
          dropdown, including an Identify Scanner button for when multiple identical scanners are connected.
          A scan from a paired scanner always routes to its assigned station automatically. Any station without a
          paired scanner still falls back to the active-station selector on the Dashboard (click a panel, or
          press 1-{draft.stations.length}).
        </p>
        <div className="mt-4 space-y-2 text-sm">
          {draft.stations.map((station) => (
            <div key={station.id} className="flex items-center justify-between">
              <span className="text-slate-500">{station.name}</span>
              <span className="text-slate-300 font-mono text-xs">
                {station.scannerDeviceId ?? 'Not paired'}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

function StationSettingsCard({
  station,
  cameras,
  mics,
  onChange,
  onRemove,
  removable
}: {
  station: StationConfig
  cameras: CameraDevice[]
  mics: string[]
  onChange: (partial: Partial<StationConfig>) => void
  onRemove: () => void
  removable: boolean
}): JSX.Element {
  return (
    <div className="border border-surface-700 rounded-lg p-4 bg-surface-850/40">
      <div className="flex items-center justify-between mb-3">
        <input
          value={station.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="bg-transparent text-sm font-semibold text-slate-100 border-b border-transparent focus:border-surface-600 outline-none"
        />
        {removable && (
          <button onClick={onRemove} className="text-xs text-rec-500 hover:text-rec-600">
            Remove
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Field label="Camera">
          <select
            value={station.cameraName ?? ''}
            onChange={(e) => onChange({ cameraName: e.target.value || null })}
            className="w-full bg-surface-800 border border-surface-600 rounded-lg px-2 py-1.5 text-sm"
          >
            <option value="">Not assigned</option>
            {cameras.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Microphone">
          <select
            value={station.micName ?? ''}
            onChange={(e) => onChange({ micName: e.target.value || null })}
            className="w-full bg-surface-800 border border-surface-600 rounded-lg px-2 py-1.5 text-sm"
          >
            <option value="">None (video only)</option>
            {mics.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Resolution">
          <select
            value={station.resolutionPreset}
            onChange={(e) => onChange({ resolutionPreset: e.target.value as StationConfig['resolutionPreset'] })}
            className="w-full bg-surface-800 border border-surface-600 rounded-lg px-2 py-1.5 text-sm"
          >
            {Object.keys(RESOLUTION_PRESETS).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </Field>

        <Field label="FPS">
          <select
            value={station.fps}
            onChange={(e) => onChange({ fps: Number(e.target.value) })}
            className="w-full bg-surface-800 border border-surface-600 rounded-lg px-2 py-1.5 text-sm"
          >
            {[24, 30, 60].map((fps) => (
              <option key={fps} value={fps}>
                {fps}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Bitrate (kbps)">
          <input
            type="number"
            min={1000}
            max={50000}
            step={500}
            value={station.bitrateKbps}
            onChange={(e) => onChange({ bitrateKbps: Number(e.target.value) })}
            className="w-full bg-surface-800 border border-surface-600 rounded-lg px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
    </div>
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
  if (busy) return <p className="text-xs text-slate-500 mt-2">Checking folder...</p>
  if (!status) return <p className="text-xs text-slate-500 mt-2">-</p>

  if (!status.exists) {
    return <p className="text-xs text-rec-500 mt-2">Folder does not exist yet.</p>
  }
  if (!status.writable) {
    return <p className="text-xs text-rec-500 mt-2">{status.error ?? 'Folder is not writable.'}</p>
  }
  return (
    <p className="text-xs text-ok-500 mt-2">
      Writable - {formatBytes(status.freeBytes)} free of {formatBytes(status.totalBytes)} on this drive.
    </p>
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-900 border border-surface-700 rounded-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-slate-100">Folder does not exist</h2>
        <p className="text-sm text-slate-400 mt-2">
          <span className="font-mono text-slate-200">{targetPath}</span> does not exist yet. Create it?
        </p>
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-surface-700 hover:bg-surface-600 text-slate-200"
          >
            No
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-accent-600 hover:bg-accent-500 text-white"
          >
            Yes, create it
          </button>
        </div>
      </div>
    </div>
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
    <section className="bg-surface-900 border border-surface-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
        {action}
      </div>
      {children}
    </section>
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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full relative transition-colors ${checked ? 'bg-accent-600' : 'bg-surface-600'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : ''
        }`}
      />
    </button>
  )
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' }): JSX.Element | null {
  if (state === 'idle') return null
  return <span className="text-xs text-slate-500">{state === 'saving' ? 'Saving...' : 'Saved'}</span>
}
