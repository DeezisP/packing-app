// Types shared between the Electron main process and the React renderer.
// Keep this file free of Node/DOM-specific APIs so it can be imported from either side.

export interface Resolution {
  width: number
  height: number
}

/** A named recording-quality mode optimized for the EMEET SmartCam S600 -
 *  selecting one atomically sets resolution, frame rate, and encoder bitrate
 *  together, so there is never a free-form/inconsistent combination of the
 *  three (see StationConfig.qualityPreset, the only place these values are
 *  chosen from). */
export interface QualityPreset {
  id: string
  label: string
  width: number
  height: number
  fps: number
  bitrateKbps: number
}

export const QUALITY_PRESETS = {
  '4k30': { id: '4k30', label: 'Ultra HD (4K)', width: 3840, height: 2160, fps: 30, bitrateKbps: 25000 },
  '1080p60': { id: '1080p60', label: 'Full HD High Frame Rate', width: 1920, height: 1080, fps: 60, bitrateKbps: 12000 },
  '1080p30': { id: '1080p30', label: 'Full HD Standard', width: 1920, height: 1080, fps: 30, bitrateKbps: 8000 },
  '720p30': { id: '720p30', label: 'HD', width: 1280, height: 720, fps: 30, bitrateKbps: 5000 },
  '480p30': { id: '480p30', label: 'Low Bandwidth', width: 640, height: 480, fps: 30, bitrateKbps: 2000 }
} as const satisfies Record<string, QualityPreset>

export type QualityPresetId = keyof typeof QUALITY_PRESETS

export const DEFAULT_QUALITY_PRESET_ID: QualityPresetId = '1080p30'

/** One resolution/frame-rate combination a camera reported it can actually
 *  produce (via ffmpeg's `-list_options`, see CameraManager.getCapabilities) -
 *  `maxFps` is the highest frame rate that resolution supports, not
 *  necessarily the only one. */
export interface CameraCapabilityOption {
  width: number
  height: number
  maxFps: number
}

/** Whether a quality preset is achievable on a camera, given its detected
 *  capabilities. An empty `capabilities` list means detection didn't produce
 *  anything usable (unsupported driver, probe failure, or not probed yet) -
 *  in that case every preset is treated as supported (fail open) rather than
 *  blocking recording on an inconclusive probe. */
export function isPresetSupported(preset: QualityPreset, capabilities: readonly CameraCapabilityOption[]): boolean {
  if (capabilities.length === 0) return true
  return capabilities.some((c) => c.width === preset.width && c.height === preset.height && c.maxFps >= preset.fps - 0.5)
}

export interface CameraDevice {
  /** Stable unique identifier - ffmpeg's DirectShow "Alternative name" device
   *  path (e.g. `@device_pnp_\\?\usb#vid_...#{...}\global`) when the driver
   *  reports one, which is what makes two identical camera models
   *  distinguishable. Falls back to `name` for the rare driver that doesn't
   *  report an alternative name, in which case it behaves exactly as before
   *  (friendly-name based) for that single device. This is the value ffmpeg
   *  is actually told to open - never the friendly name, since that can
   *  collide across devices. */
  id: string
  /** DirectShow friendly name - display only, NOT guaranteed unique
   *  (identical camera models report the exact same name). */
  name: string
  /** ffmpeg's own dshow enumeration order - used to number duplicate-name
   *  devices ("Camera Name (1)", "(2)", ...) consistently with how the
   *  renderer correlates them against the browser's own device list for
   *  live preview (see useCameraPreview). */
  index: number
  connected: boolean
}

/** Groups cameras that share a friendly name and assigns each a stable,
 *  1-based display suffix ("Camera (1)", "Camera (2)") in ffmpeg's own
 *  enumeration order - unique names are left untouched. Used everywhere a
 *  camera name is shown to the operator (dropdowns, tables, station cards)
 *  so two identical webcams are never visually indistinguishable. */
export function buildCameraDisplayNames(cameras: CameraDevice[]): Map<string, string> {
  const byName = new Map<string, CameraDevice[]>()
  for (const cam of cameras) {
    const group = byName.get(cam.name)
    if (group) group.push(cam)
    else byName.set(cam.name, [cam])
  }
  const result = new Map<string, string>()
  for (const [name, group] of byName) {
    if (group.length === 1) {
      result.set(group[0].id, name)
      continue
    }
    const sorted = [...group].sort((a, b) => a.index - b.index)
    sorted.forEach((cam, i) => result.set(cam.id, `${name} (${i + 1})`))
  }
  return result
}

/** Resolves which currently-known camera a station's configuration refers
 *  to: `cameraId` (the unique device path) wins when it matches a live
 *  device; otherwise falls back to the first device whose friendly name
 *  matches the legacy `cameraName` field, so configs written before
 *  `cameraId` existed keep working exactly as they did (this only stays
 *  ambiguous for a config that both predates this fix AND has two identical
 *  cameras - re-selecting the camera once in Settings resolves it for good).
 *  Returns null if nothing currently connected matches either field. */
export function resolveStationCameraId(
  station: { cameraId?: string | null; cameraName: string | null },
  cameras: CameraDevice[]
): string | null {
  if (station.cameraId) {
    const byId = cameras.find((c) => c.id === station.cameraId)
    if (byId) return byId.id
  }
  if (station.cameraName) {
    const byName = cameras.find((c) => c.name === station.cameraName)
    if (byName) return byName.id
  }
  return null
}

export interface StationConfig {
  id: string
  name: string
  /** Disabled stations are hidden from the Dashboard and never accept scans,
   *  but stay configured in Settings so they can be re-enabled later.
   *  Missing on configs written before this field existed - ConfigManager
   *  normalizes those to `true` on load so upgrades never hide a station. */
  enabled: boolean
  /** Unique device identifier (CameraDevice.id) - the primary way a station's
   *  camera is resolved. Null on configs written before this field existed. */
  cameraId: string | null
  /** Friendly name, kept in sync with `cameraId` for display (metadata.json,
   *  the database, overlay text) and as a fallback match for older configs
   *  that only ever stored a name - see resolveStationCameraId(). */
  cameraName: string | null
  micName: string | null
  /** Drives resolution, fps, and bitrate together - see QUALITY_PRESETS.
   *  `fps`/`bitrateKbps` below are kept in sync with this by ConfigManager
   *  (normalizeStation) so RecordingEngine/StationManager/Database, which
   *  already read `fps`/`bitrateKbps` directly, need no changes of their own. */
  qualityPreset: QualityPresetId
  fps: number
  bitrateKbps: number
  scannerDeviceId: string | null
  /** null = inherit the app-wide save location; otherwise an absolute path
   *  (or one relative to the portable app root) used only by this station. */
  saveLocationOverride: string | null
}

/** `scannerMissing`/`cameraMissing` cover both "never assigned" and "assigned
 *  but that device id no longer resolves to anything currently known" -
 *  operationally the same problem (a scan or a recording attempt at this
 *  station has nowhere to go). `scannerDuplicate`/`cameraDuplicate` mean the
 *  same physical device is wired to more than one station, which makes scan
 *  routing and camera assignment ambiguous - see resolveStationCameraId and
 *  StationManager.resolveTargetStationId, both of which just take the first
 *  match and would otherwise silently ignore every other station sharing it. */
export type StationValidationIssueType = 'scannerMissing' | 'cameraMissing' | 'scannerDuplicate' | 'cameraDuplicate'

export interface StationValidationIssue {
  stationId: string
  stationName: string
  type: StationValidationIssueType
}

/** Checks every *enabled* station's scanner/camera assignment against the
 *  currently known device lists - disabled stations are exempt since they
 *  never accept scans or record (see DashboardPage's enabledStations
 *  filter), so an intentionally-parked station with no devices assigned
 *  isn't reported as broken. `knownScannerIds`/`knownCameraIds` are the
 *  device ids each device manager currently reports as present - a station
 *  pointing at an id outside that set is exactly as unusable as one with no
 *  id at all, so both cases fold into the same missing-* issue. Pure and
 *  synchronous so it can run on every relevant change (config edit, device
 *  plug/unplug) without any IPC round-trip of its own. */
export function validateStations(
  stations: StationConfig[],
  knownScannerIds: ReadonlySet<string>,
  knownCameraIds: ReadonlySet<string>
): StationValidationIssue[] {
  const enabled = stations.filter((s) => s.enabled)

  const scannerOwners = new Map<string, StationConfig[]>()
  const cameraOwners = new Map<string, StationConfig[]>()
  for (const station of enabled) {
    if (station.scannerDeviceId) {
      const group = scannerOwners.get(station.scannerDeviceId) ?? []
      group.push(station)
      scannerOwners.set(station.scannerDeviceId, group)
    }
    if (station.cameraId) {
      const group = cameraOwners.get(station.cameraId) ?? []
      group.push(station)
      cameraOwners.set(station.cameraId, group)
    }
  }

  const issues: StationValidationIssue[] = []
  for (const station of enabled) {
    if (!station.scannerDeviceId || !knownScannerIds.has(station.scannerDeviceId)) {
      issues.push({ stationId: station.id, stationName: station.name, type: 'scannerMissing' })
    } else if ((scannerOwners.get(station.scannerDeviceId)?.length ?? 0) > 1) {
      issues.push({ stationId: station.id, stationName: station.name, type: 'scannerDuplicate' })
    }

    if (!station.cameraId || !knownCameraIds.has(station.cameraId)) {
      issues.push({ stationId: station.id, stationName: station.name, type: 'cameraMissing' })
    } else if ((cameraOwners.get(station.cameraId)?.length ?? 0) > 1) {
      issues.push({ stationId: station.id, stationName: station.name, type: 'cameraDuplicate' })
    }
  }
  return issues
}

export type ThemeMode = 'dark' | 'light'

/** A scanner the operator has explicitly confirmed via the Identify Scanner
 *  workflow - the Device Pairing page only ever shows devices from this list,
 *  never the raw HID device enumeration (which includes mice, headsets,
 *  webcam controls, and other irrelevant peripherals). */
export interface IdentifiedScanner {
  id: string
  name: string
}

export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Configures the text overlay burned directly into recorded video frames
 *  (via canvas compositing during live capture - see canvasOverlay.ts/
 *  useRecordingCapture.ts in the renderer), and OverlayPreview in the
 *  renderer for the separate WYSIWYG live-preview that mirrors this same
 *  config as a CSS layer. */
export interface OverlayConfig {
  enabled: boolean
  showBarcode: boolean
  showDate: boolean
  showTime: boolean
  showTimer: boolean
  showStation: boolean
  showCamera: boolean
  position: OverlayPosition
  fontSize: number
  fontColor: string
  backgroundColor: string
  backgroundOpacity: number
}

/** Reports every barcode scan to an external warehouse system - see
 *  ApiQueueService. `apiKey` is a live credential; it lives only in the
 *  per-machine config.json (gitignored, never the shipped
 *  config.default.json template), the same way saveLocation and every other
 *  machine-specific setting already does. It is also never sent to the
 *  renderer in plaintext once set - see registerIpcHandlers' config
 *  sanitization - so it never round-trips through the Settings UI's own
 *  state after the initial entry. */
export interface WarehouseApiConfig {
  enabled: boolean
  /** The exact endpoint every scan is POSTed to - not a prefix, no path is
   *  appended to it. */
  url: string
  apiKey: string
  /** Sent as `scannerUser` on every request - this app has no per-operator
   *  login, so it's one config-wide value rather than a real per-scan
   *  identity. */
  scannerUser: string
  /** Per-request timeout in milliseconds. */
  timeout: number
}

/** What the renderer sees in `warehouseApi.apiKey` in place of a real,
 *  already-stored key - see registerIpcHandlers' sanitizeConfigForRenderer /
 *  resolveIncomingConfigUpdate. Shared so main and renderer never drift on
 *  the sentinel value. */
export const API_KEY_PLACEHOLDER = '••••••••'

/** Result of a one-off, unqueued diagnostic POST triggered by the Settings
 *  page's "Test Connection" button - distinct from the real scan queue
 *  (ApiQueueService), which never surfaces its raw HTTP response back to
 *  the renderer this way. */
export interface WarehouseApiTestResult {
  success: boolean
  statusCode: number | null
  responseBody: string | null
  error: string | null
  durationMs: number
}

export interface AppConfig {
  saveLocation: string
  theme: ThemeMode
  stations: StationConfig[]
  autoStartWindows: boolean
  dbBackupEnabled: boolean
  dbBackupIntervalHours: number
  activeStationId: string
  identifiedScanners: IdentifiedScanner[]
  overlay: OverlayConfig
  warehouseApi: WarehouseApiConfig
}

/** The values available to plug into an overlay line - some are static per
 *  recording (barcode/station/camera), some update every second (date/time/
 *  timer). Kept separate from OverlayConfig so the same builder works for
 *  both the main-process text-file writer and the renderer's live preview. */
export interface OverlayFieldData {
  barcode: string
  date: string
  time: string
  timer: string
  station: string
  camera: string
}

/** Single source of truth for "what text goes in the overlay" - used by both
 *  the main process (writing the file ffmpeg burns in) and the renderer
 *  (live preview), so the preview never drifts from what's actually
 *  recorded. */
export function buildOverlayLines(config: OverlayConfig, data: OverlayFieldData): string[] {
  const lines: string[] = []
  if (config.showBarcode) lines.push(`Order: ${data.barcode}`)
  if (config.showDate) lines.push(`Date: ${data.date}`)
  if (config.showTime) lines.push(`Time: ${data.time}`)
  if (config.showTimer) lines.push(`Recording: ${data.timer}`)
  if (config.showStation) lines.push(`Station: ${data.station}`)
  if (config.showCamera) lines.push(`Camera: ${data.camera}`)
  return lines
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Always HH:MM:SS (never omits the hours segment like some other duration
 *  formatters in this app do) - matches the overlay spec's example exactly,
 *  and is shared so the burned-in video and the live preview never drift. */
export function formatHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** Shared with formatHms's own reasoning: both the on-screen WYSIWYG overlay
 *  (useOverlayFieldData) and the actual burned-in recording (canvas
 *  compositing, see useRecordingCapture/canvasOverlay) format the current
 *  date/time this same way, so they can never drift from each other. */
export function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatTimeLocal(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export type RecordingStatus = 'recording' | 'completed' | 'interrupted' | 'error'

export interface RecordingRecord {
  id: number
  barcode: string
  station: string
  camera: string
  startTime: string
  endTime: string | null
  durationSeconds: number | null
  videoPath: string
  thumbnailPath: string | null
  /** packing-media:// URL usable directly as a <video>/<img> src in the renderer. */
  videoUrl: string
  thumbnailUrl: string | null
  resolution: string
  fps: number
  bitrateKbps: number
  status: RecordingStatus
  createdDate: string
  lastViewed: string | null
  /** Current size of packing.mp4 in bytes, read from disk at query time (not
   *  stored in the database) - always reflects the real file, including one
   *  still growing while `status === 'recording'`. 0 if the file is missing. */
  fileSize: number
}

export interface SearchFilters {
  barcode?: string
  station?: string
  camera?: string
  dateFrom?: string
  dateTo?: string
}

export interface StationRuntimeState {
  stationId: string
  /** 'processing' covers the window between the renderer's live capture
   *  ending and the recording being fully usable (webm->mp4 transcode,
   *  decode verification, thumbnail extraction, DB/metadata write, warehouse
   *  API enqueue all still running) - see StationManager.stopRecording. Kept
   *  distinct from 'recording' so the dashboard stops showing a frozen
   *  elapsed timer for work that's no longer live. The camera's live preview
   *  is never affected by any of this - see CaptureIngestService/
   *  useRecordingCapture, the getUserMedia stream is never touched by
   *  recording start/stop at all. */
  status: 'idle' | 'recording' | 'processing' | 'error'
  barcode: string | null
  cameraName: string | null
  cameraConnected: boolean
  scannerName: string | null
  scannerConnected: boolean
  startedAt: string | null
  elapsedSeconds: number
  lastError: string | null
}

/** A physical USB HID keyboard-class device (barcode scanners register with
 *  Windows this way). `id` is a stable, normalized PnP Instance ID - the same
 *  value used for StationConfig.scannerDeviceId. */
export interface ScannerDevice {
  id: string
  name: string
  connected: boolean
}

export interface WrongBarcodeEvent {
  stationId: string
  scannedBarcode: string
  activeBarcode: string
}

export interface DuplicateBarcodeEvent {
  stationId: string
  barcode: string
  existingFolder: string
}

export interface DiskUsageInfo {
  saveLocation: string
  freeBytes: number
  totalBytes: number
  usedPercent: number
  lowDiskWarning: boolean
}

export interface SystemStatusInfo {
  uptimeSeconds: number
  totalRecordings: number
  activeRecordings: number
  disk: DiskUsageInfo
}

/** Written as metadata.json alongside packing.mp4 when a recording
 *  completes - a plain-file, human-readable companion to the database row,
 *  useful for anyone processing the Videos/ folder directly. */
export interface RecordingMetadata {
  barcode: string
  station: string
  camera: string
  startTime: string
  endTime: string
  duration: string
  resolution: string
  fps: number
  fileSize: number
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Result of probing a candidate (or the currently configured) save folder. */
export interface SaveLocationStatus {
  path: string
  exists: boolean
  writable: boolean
  freeBytes: number
  totalBytes: number
  error: string | null
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  latestVersion: string | null
  releaseNotes: string | null
  progressPercent: number | null
  error: string | null
}

/** Windows' own PnP device record for a camera (from `Get-PnpDevice -Class
 *  Camera`) - the same source Device Manager reads from. Independent of
 *  ffmpeg entirely; used on the Diagnostics page to cross-check that ffmpeg
 *  and Windows agree on how many physical cameras are present. */
export interface WindowsCameraInfo {
  friendlyName: string
  instanceId: string
  status: string
}

/** How a station's configured camera currently resolves, for the
 *  Diagnostics page's "current assignment" table - mirrors
 *  CameraManager.resolveStationCamera but pre-resolved for display. */
export interface DiagnosticsStationAssignment {
  stationId: string
  stationName: string
  cameraId: string | null
  cameraName: string | null
  resolvedCameraId: string | null
  connected: boolean
}

/** Everything the main process knows about camera detection, gathered in one
 *  call for Settings -> Diagnostics. The renderer adds its own
 *  navigator.mediaDevices (Chromium) list on top before rendering/exporting,
 *  since only the renderer can see that. */
export interface DiagnosticsSnapshot {
  ffmpeg: {
    /** Raw stderr from the most recent `ffmpeg -list_devices` run, exactly
     *  as ffmpeg printed it - lets a mismatch between what ffmpeg reported
     *  and what got parsed out of it be seen directly. */
    raw: string
    video: CameraDevice[]
    audio: string[]
  }
  windows: WindowsCameraInfo[]
  stations: DiagnosticsStationAssignment[]
  recentLogs: LogEntry[]
  appVersion: string
  ffmpegPath: string
}

export interface DiagnosticsTestResult {
  success: boolean
  error: string | null
  ffmpegCommand: string
}

export interface DeleteRecordingResult {
  success: boolean
  error: string | null
}

/** Cheap pre-flight file-access check run before the built-in player loads
 *  a recording - existence/readability/lock/signature only, no decoding
 *  (that already happened once at recording-stop time, see
 *  RecordingEngine.verifyRecording). Lets the player show a specific,
 *  correct error ("file was moved", "file is locked by another program")
 *  instead of a generic "cannot play video" when something's actually wrong
 *  with the file itself, as opposed to the player implementation. */
export interface PlaybackPreflightResult {
  exists: boolean
  readable: boolean
  locked: boolean
  sizeBytes: number
  looksLikeValidMp4: boolean
  error: string | null
}

/** Snapshot of the external-API scan queue's health, for the Settings page -
 *  see ApiQueueService/Database's api_queue table. */
export interface ApiQueueStatus {
  pending: number
  lastError: string | null
  lastSuccessAt: string | null
}

/** Main -> renderer: tells the station's already-live camera preview (see
 *  useRecordingCapture) to start capturing its own already-open MediaStream
 *  instead of opening a new/competing one - the camera itself is never
 *  reopened or renegotiated. Keyed by `sessionId`, not just `stationId`,
 *  because a new recording can legitimately start for a station whose
 *  previous recording is still `status: 'processing'` (finalizing) - see
 *  StationManager.handleScan/CaptureIngestService's own doc comments. */
export interface CaptureBeginPayload {
  sessionId: string
  stationId: string
  cameraId: string
  micName: string | null
  preset: { width: number; height: number; fps: number; bitrateKbps: number }
  /** Null when the overlay is disabled - the renderer then records the raw
   *  camera track directly instead of compositing through a canvas. */
  overlay: { config: OverlayConfig; staticData: { barcode: string; station: string; camera: string } } | null
  startedAt: string
}

/** Main -> renderer: stop capturing this session. The renderer keeps the
 *  live preview running regardless - this only stops the MediaRecorder. */
export interface CaptureEndPayload {
  sessionId: string
  stationId: string
}

/** Renderer -> main: one chunk of the live MediaRecorder capture. `final:
 *  true` is sent once, as an empty sentinel, only after MediaRecorder's
 *  `onstop` event fires (which the spec guarantees happens after the last
 *  real `dataavailable`) - see CaptureIngestService.writeChunk. */
export interface CaptureChunkPayload {
  sessionId: string
  seq: number
  data: ArrayBuffer
  final: boolean
}

/** Renderer -> main: the capture session failed to start or continue (mic
 *  device missing, unsupported MediaRecorder mimeType, camera track ended
 *  unexpectedly) - mirrors the old ffmpeg `unexpectedExit` signal so
 *  StationManager's error handling stays the same shape. */
export interface CaptureErrorPayload {
  sessionId: string
  stationId: string
  message: string
}
