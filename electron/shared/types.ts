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
  cameraName: string | null
  micName: string | null
  resolutionPreset: keyof typeof RESOLUTION_PRESETS
  fps: number
  bitrateKbps: number
  scannerDeviceId: string | null
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

export interface AppConfig {
  saveLocation: string
  theme: ThemeMode
  stations: StationConfig[]
  autoStartWindows: boolean
  dbBackupEnabled: boolean
  dbBackupIntervalHours: number
  activeStationId: string
  identifiedScanners: IdentifiedScanner[]
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
