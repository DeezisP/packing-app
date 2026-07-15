// Types shared between the Electron main process and the React renderer.
// Keep this file free of Node/DOM-specific APIs so it can be imported from either side.

export interface Resolution {
  width: number
  height: number
}

export const RESOLUTION_PRESETS: Record<string, Resolution> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4K': { width: 3840, height: 2160 }
}

export interface CameraDevice {
  /** DirectShow device name - the value ffmpeg needs to open the device. */
  name: string
  /** Stable-ish index reported by dshow enumeration, used only for display fallback. */
  index: number
  connected: boolean
}

export interface StationConfig {
  id: string
  name: string
  /** Disabled stations are hidden from the Dashboard and never accept scans,
   *  but stay configured in Settings so they can be re-enabled later.
   *  Missing on configs written before this field existed - ConfigManager
   *  normalizes those to `true` on load so upgrades never hide a station. */
  enabled: boolean
  cameraName: string | null
  micName: string | null
  resolutionPreset: keyof typeof RESOLUTION_PRESETS
  fps: number
  bitrateKbps: number
  scannerDeviceId: string | null
  /** null = inherit the app-wide save location; otherwise an absolute path
   *  (or one relative to the portable app root) used only by this station. */
  saveLocationOverride: string | null
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
 *  (via ffmpeg's drawtext filter) - see OverlayService/RecordingEngine in
 *  the main process, and OverlayPreview in the renderer for the WYSIWYG
 *  live-preview that mirrors this same config. */
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

/** Always HH:MM:SS (never omits the hours segment like some other duration
 *  formatters in this app do) - matches the overlay spec's example exactly,
 *  and is shared so the burned-in video and the live preview never drift. */
export function formatHms(totalSeconds: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  return `${pad(h)}:${pad(m)}:${pad(s)}`
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
  status: 'idle' | 'recording' | 'error'
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
