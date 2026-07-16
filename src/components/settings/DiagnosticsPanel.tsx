import { useEffect, useMemo, useState } from 'react'
import { AnimatedButton } from '../common/AnimatedButton'
import { strings } from '../../lib/strings'
import type { CameraDevice, DiagnosticsSnapshot, StationConfig } from '../../../electron/shared/types'

const T = strings.diagnostics

interface ChromiumCamera {
  deviceId: string
  groupId: string
  label: string
}

type TestState = { status: 'idle' | 'testing' | 'passed' | 'failed'; error?: string; ffmpegCommand?: string }

interface Props {
  cameras: CameraDevice[]
  cameraDisplayNames: Map<string, string>
  stations: StationConfig[]
  onTestCamera: (camera: CameraDevice) => void
}

/** Cross-references every independent camera-detection layer (Chromium's own
 *  MediaDevices enumeration, ffmpeg/DirectShow, and Windows' PnP device
 *  database) side by side, so a mismatch between them - or a camera missing
 *  from one but not the others - is visible directly instead of requiring a
 *  log-diving session. Also offers a real per-camera live-preview test and a
 *  real short ffmpeg test recording, and can export everything shown here
 *  (plus recent app logs) to a diagnostics.txt file. */
export function DiagnosticsPanel({ cameras, cameraDisplayNames, stations, onTestCamera }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [chromium, setChromium] = useState<ChromiumCamera[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'cancelled'>('idle')
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [testState, setTestState] = useState<Record<string, TestState>>({})
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function getChromiumCameras(): Promise<ChromiumCamera[]> {
    let devices = await navigator.mediaDevices.enumerateDevices()
    let videoInputs = devices.filter((d) => d.kind === 'videoinput')
    if (videoInputs.some((d) => !d.label)) {
      // Labels (and often distinct deviceIds) are withheld until camera
      // permission has been granted at least once - request it briefly just
      // to unlock accurate enumeration, then release the camera immediately.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        stream.getTracks().forEach((t) => t.stop())
        devices = await navigator.mediaDevices.enumerateDevices()
        videoInputs = devices.filter((d) => d.kind === 'videoinput')
      } catch {
        // Permission denied or no camera available - fall back to whatever
        // enumerateDevices could see without it.
      }
    }
    return videoInputs.map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label || T.unlabeledDevice }))
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [snap, chromiumCameras] = await Promise.all([window.electronAPI.diagnostics.get(), getChromiumCameras()])
      setSnapshot(snap)
      setChromium(chromiumCameras)
      window.electronAPI.system.log('info', 'Diagnostics page: snapshot refreshed', {
        ffmpegCount: snap.ffmpeg.video.length,
        windowsCount: snap.windows.length,
        chromiumCount: chromiumCameras.length
      })
    } finally {
      setLoading(false)
    }
  }

  async function runRecordingTest(camera: CameraDevice, micName: string | null): Promise<void> {
    setTestState((s) => ({ ...s, [camera.id]: { status: 'testing' } }))
    const result = await window.electronAPI.diagnostics.testRecording(camera.id, micName)
    setTestState((s) => ({
      ...s,
      [camera.id]: {
        status: result.success ? 'passed' : 'failed',
        error: result.error ?? undefined,
        ffmpegCommand: result.ffmpegCommand
      }
    }))
  }

  const stationByCameraId = useMemo(() => {
    const map = new Map<string, StationConfig>()
    for (const s of stations) {
      const key = s.cameraId ?? (s.cameraName ? `name:${s.cameraName}` : null)
      if (key) map.set(key, s)
    }
    return map
  }, [stations])

  function ownerOf(camera: CameraDevice): StationConfig | undefined {
    return stationByCameraId.get(camera.id) ?? stationByCameraId.get(`name:${camera.name}`)
  }

  async function doExport(): Promise<void> {
    if (!snapshot) return
    setExportState('exporting')
    const text = buildDiagnosticsText(snapshot, chromium ?? [], cameras, cameraDisplayNames, stations, testState)
    const path = await window.electronAPI.diagnostics.export(text)
    if (path) {
      setExportedPath(path)
      setExportState('done')
    } else {
      setExportState('cancelled')
    }
    window.setTimeout(() => setExportState('idle'), 4000)
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-400">{T.intro}</p>

      <div className="flex items-center gap-6 flex-wrap text-xs">
        <span className="text-slate-500">
          {T.previewBackendLabel} <span className="text-slate-300 font-medium">{T.previewBackendValue}</span>
        </span>
        <span className="text-slate-500">
          {T.recordingBackendLabel} <span className="text-slate-300 font-medium">{T.recordingBackendValue}</span>
        </span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <AnimatedButton size="sm" onClick={refresh} disabled={loading}>
          {loading ? T.refreshing : T.refresh}
        </AnimatedButton>
        <AnimatedButton size="sm" variant="primary" onClick={doExport} disabled={exportState === 'exporting' || !snapshot}>
          {exportState === 'exporting' ? T.exporting : T.exportButton}
        </AnimatedButton>
        {exportState === 'done' && exportedPath && <span className="text-xs text-ok-500">{T.exportedTo(exportedPath)}</span>}
        {exportState === 'cancelled' && <span className="text-xs text-slate-500">{T.exportCancelled}</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <DetectionColumn title={T.detectedByChromium(chromium?.length ?? 0)}>
          {(chromium ?? []).map((d) => (
            <div key={d.deviceId} className="text-xs border border-white/10 rounded-lg px-3 py-2 bg-surface-850/30">
              <p className="text-slate-200 font-medium">{d.label}</p>
              <p className="text-slate-500 font-mono mt-0.5 break-all">deviceId: {d.deviceId}</p>
              <p className="text-slate-500 font-mono break-all">groupId: {d.groupId}</p>
            </div>
          ))}
          {chromium && chromium.length === 0 && <EmptyRow />}
        </DetectionColumn>

        <DetectionColumn title={T.detectedByFfmpeg(snapshot?.ffmpeg.video.length ?? 0)}>
          {(snapshot?.ffmpeg.video ?? []).map((d) => (
            <div key={d.id} className="text-xs border border-white/10 rounded-lg px-3 py-2 bg-surface-850/30">
              <p className="text-slate-200 font-medium">{d.name}</p>
              <p className="text-slate-500 font-mono mt-0.5 break-all">{T.ffmpegDeviceId}: {d.id}</p>
              <p className="text-slate-500">index: {d.index}</p>
            </div>
          ))}
          {snapshot && snapshot.ffmpeg.video.length === 0 && <EmptyRow />}
        </DetectionColumn>

        <DetectionColumn title={T.detectedByWindows(snapshot?.windows.length ?? 0)}>
          {(snapshot?.windows ?? []).map((d) => (
            <div key={d.instanceId} className="text-xs border border-white/10 rounded-lg px-3 py-2 bg-surface-850/30">
              <p className="text-slate-200 font-medium">{d.friendlyName}</p>
              <p className="text-slate-500 font-mono mt-0.5 break-all">{T.windowsInstanceId}: {d.instanceId}</p>
              <p className={d.status === 'OK' ? 'text-ok-500' : 'text-warn-500'}>
                {T.windowsStatus}: {d.status}
              </p>
            </div>
          ))}
          {snapshot && snapshot.windows.length === 0 && <EmptyRow />}
        </DetectionColumn>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">{T.stationAssignments}</h3>
        <div className="space-y-3">
          {cameras.length === 0 && <p className="text-sm text-slate-600 text-center py-6">{T.noneDetected}</p>}
          {cameras.map((camera) => {
            const owner = ownerOf(camera)
            const test = testState[camera.id] ?? { status: 'idle' }
            return (
              <div
                key={camera.id}
                className="flex items-center justify-between gap-4 border border-white/10 rounded-lg px-4 py-3 bg-surface-850/30 flex-wrap"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-100">{cameraDisplayNames.get(camera.id) ?? camera.name}</p>
                  <p className="text-xs text-slate-500 font-mono mt-0.5 break-all">
                    {T.internalId}: {camera.id}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {owner ? T.cameraAssignedTo(owner.name) : T.cameraUnassigned}
                  </p>
                  {test.status === 'passed' && <p className="text-xs text-ok-500 mt-0.5">{T.testPassed}</p>}
                  {test.status === 'failed' && <p className="text-xs text-rec-500 mt-0.5">{T.testFailed(test.error ?? '')}</p>}
                  {test.ffmpegCommand && (
                    <p className="text-[11px] text-slate-600 font-mono mt-1 break-all">
                      {T.generatedFfmpegCommand}: {test.ffmpegCommand}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <AnimatedButton size="sm" onClick={() => onTestCamera(camera)}>
                    {strings.devicePairing.testCamera}
                  </AnimatedButton>
                  <AnimatedButton
                    size="sm"
                    onClick={() => runRecordingTest(camera, owner?.micName ?? null)}
                    disabled={test.status === 'testing'}
                  >
                    {test.status === 'testing' ? T.testing : T.recordingTest}
                  </AnimatedButton>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="text-xs text-slate-500 hover:text-slate-300 underline"
        >
          {showRaw ? T.hideRaw : T.showRaw}
        </button>
        {showRaw && (
          <pre className="mt-2 text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all bg-surface-950/60 border border-white/10 rounded-lg p-3 max-h-64 overflow-auto">
            {snapshot?.ffmpeg.raw || '(empty)'}
          </pre>
        )}
      </div>
    </div>
  )
}

function DetectionColumn({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">{title}</h3>
      <div className="space-y-2 max-h-72 overflow-auto pr-1">{children}</div>
    </div>
  )
}

function EmptyRow(): JSX.Element {
  return <p className="text-xs text-slate-600 text-center py-4">{T.noneDetected}</p>
}

function buildDiagnosticsText(
  snapshot: DiagnosticsSnapshot,
  chromium: ChromiumCamera[],
  cameras: CameraDevice[],
  cameraDisplayNames: Map<string, string>,
  stations: StationConfig[],
  testState: Record<string, TestState>
): string {
  const lines: string[] = []
  const now = new Date().toISOString()
  lines.push('PackingRecorder Camera Diagnostics')
  lines.push(`Generated: ${now}`)
  lines.push(`App version: ${snapshot.appVersion}`)
  lines.push(`ffmpeg path: ${snapshot.ffmpegPath}`)
  lines.push(`${T.previewBackendLabel} ${T.previewBackendValue}`)
  lines.push(`${T.recordingBackendLabel} ${T.recordingBackendValue}`)
  lines.push('')

  lines.push('=== Cameras detected by Chromium (navigator.mediaDevices) ===')
  if (chromium.length === 0) lines.push('(none)')
  chromium.forEach((d, i) => {
    lines.push(`Camera ${i + 1}`)
    lines.push(`  Label: ${d.label}`)
    lines.push(`  Device ID: ${d.deviceId}`)
    lines.push(`  Group ID: ${d.groupId}`)
    lines.push('--------------------------')
  })
  lines.push('')

  lines.push('=== Cameras detected by FFmpeg (DirectShow) ===')
  if (snapshot.ffmpeg.video.length === 0) lines.push('(none)')
  snapshot.ffmpeg.video.forEach((d, i) => {
    lines.push(`Camera ${i + 1}`)
    lines.push(`  Friendly Name: ${d.name}`)
    lines.push(`  Device ID (Alternative name): ${d.id}`)
    lines.push(`  Enumeration Index: ${d.index}`)
    lines.push('--------------------------')
  })
  lines.push('')

  lines.push('=== Cameras detected by Windows (Get-PnpDevice -Class Camera) ===')
  if (snapshot.windows.length === 0) lines.push('(none)')
  snapshot.windows.forEach((d, i) => {
    lines.push(`Camera ${i + 1}`)
    lines.push(`  Friendly Name: ${d.friendlyName}`)
    lines.push(`  Instance ID: ${d.instanceId}`)
    lines.push(`  Status: ${d.status}`)
    lines.push('--------------------------')
  })
  lines.push('')

  lines.push('=== Internal identifiers and station assignments ===')
  cameras.forEach((camera) => {
    const owner = stations.find((s) => s.cameraId === camera.id || (!s.cameraId && s.cameraName === camera.name))
    const test = testState[camera.id]
    lines.push(`Display Name: ${cameraDisplayNames.get(camera.id) ?? camera.name}`)
    lines.push(`  Internal Unique ID: ${camera.id}`)
    lines.push(`  Assigned Station: ${owner ? owner.name : '(unassigned)'}`)
    lines.push(`  Recording Test: ${test ? test.status + (test.error ? ` - ${test.error}` : '') : 'not run'}`)
    if (test?.ffmpegCommand) lines.push(`  Generated FFmpeg Command: ${test.ffmpegCommand}`)
    lines.push('--------------------------')
  })
  lines.push('')

  lines.push('=== Raw ffmpeg dshow output ===')
  lines.push(snapshot.ffmpeg.raw || '(empty)')
  lines.push('')

  lines.push('=== Recent application logs ===')
  snapshot.recentLogs.forEach((entry) => {
    lines.push(`[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`)
  })

  return lines.join('\n')
}
