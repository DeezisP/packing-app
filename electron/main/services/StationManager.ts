import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { configManager } from './ConfigManager'
import { database } from './Database'
import { recordingEngine } from './RecordingEngine'
import { cameraManager } from './CameraManager'
import { scannerManager } from './ScannerManager'
import { overlayService } from './OverlayService'
import { writeRecordingMetadata } from './MetadataService'
import { getDiskUsage, CRITICAL_DISK_STOP_BYTES } from './DiskMonitor'
import { validateSaveLocation } from './SaveLocationValidator'
import { logger } from './Logger'
import { QUALITY_PRESETS, buildCameraDisplayNames, validateStations, isPresetSupported } from '@shared/types'
import type {
  StationRuntimeState,
  WrongBarcodeEvent,
  DuplicateBarcodeEvent,
  StationConfig,
  ScannerDevice,
  SaveLocationStatus,
  StationValidationIssue
} from '@shared/types'

const TICK_INTERVAL_MS = 1000
const SAVE_LOCATION_HEALTH_INTERVAL_MS = 10000

interface StationRuntime extends StationRuntimeState {
  dbId: number | null
  videoPath: string | null
}

/** The barcode-driven state machine described in the spec:
 *  first scan of a barcode starts recording, second scan of the SAME barcode
 *  stops it, a different barcode while recording is rejected ("wrong barcode"),
 *  and a barcode that already has a folder on disk triggers a duplicate prompt
 *  instead of silently overwriting anything. Every station runs this
 *  independently so Station A and Station B never interfere with each other. */
class StationManager extends EventEmitter {
  private states = new Map<string, StationRuntime>()
  private tickTimer: NodeJS.Timeout | null = null
  private saveLocationHealthTimer: NodeJS.Timeout | null = null
  private lastSaveLocationStatus: SaveLocationStatus | null = null
  private lastValidationIssues: StationValidationIssue[] = []

  init(): void {
    for (const station of configManager.get().stations) {
      const scanner = resolveScannerDisplay(station)
      this.states.set(station.id, {
        stationId: station.id,
        status: 'idle',
        barcode: null,
        cameraName: resolveCameraDisplay(station).name,
        cameraConnected: false,
        scannerName: scanner.name,
        scannerConnected: scanner.connected,
        startedAt: null,
        elapsedSeconds: 0,
        lastError: null,
        dbId: null,
        videoPath: null
      })
    }

    recordingEngine.on('unexpectedExit', ({ stationId, message }) => {
      const state = this.states.get(stationId)
      if (!state) return
      if (state.dbId) database.markError(state.dbId, message)
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Recording stopped unexpectedly', { stationId, message })
    })

    // Ignore the event payload and re-resolve from cameraManager's own
    // current list instead - it's already updated by the time this fires,
    // and resolving per-station (id-first, name-fallback) is what correctly
    // distinguishes two identically-named cameras instead of a shared
    // name -> connected Set that can't tell them apart.
    cameraManager.on('changed', () => {
      for (const [stationId, state] of this.states) {
        const station = this.getStationConfig(stationId)
        if (!station) continue
        const display = resolveCameraDisplay(station)
        if (display.connected !== state.cameraConnected || display.name !== state.cameraName) {
          this.setState(stationId, { cameraConnected: display.connected, cameraName: display.name })
          if (display.connected) {
            logger.info('Camera reconnected', { stationId, camera: display.name })
          } else {
            logger.warn('Camera disconnected', { stationId, camera: display.name })
          }
        }
      }
      this.recheckValidation()
    })

    scannerManager.on('changed', () => {
      for (const [stationId] of this.states) {
        const station = this.getStationConfig(stationId)
        if (!station) continue
        const scanner = resolveScannerDisplay(station)
        const state = this.states.get(stationId)!
        if (scanner.connected !== state.scannerConnected || scanner.name !== state.scannerName) {
          this.setState(stationId, { scannerName: scanner.name, scannerConnected: scanner.connected })
          if (station.scannerDeviceId) {
            if (scanner.connected) {
              logger.info('Paired scanner reconnected', { stationId, scanner: scanner.name })
            } else {
              logger.warn('Paired scanner disconnected', { stationId, scanner: scanner.name })
            }
          }
        }
      }
      this.recheckValidation()
    })

    configManager.on('changed', (cfg: { stations: StationConfig[] }) => this.reconcileStations(cfg.stations))
    // Re-check immediately when the save location itself changes, instead of
    // waiting up to SAVE_LOCATION_HEALTH_INTERVAL_MS for the next poll.
    configManager.on('changed', () => {
      this.checkSaveLocationHealth().catch((err) =>
        logger.error('Save location health check failed', { error: (err as Error).message })
      )
    })
    configManager.on('changed', () => this.recheckValidation())

    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
    this.saveLocationHealthTimer = setInterval(
      () => this.checkSaveLocationHealth().catch(() => undefined),
      SAVE_LOCATION_HEALTH_INTERVAL_MS
    )
    this.checkSaveLocationHealth().catch((err) =>
      logger.error('Initial save location health check failed', { error: (err as Error).message })
    )

    // Startup validation - runs once against whatever CameraManager/
    // ScannerManager already know at this point (their own startPolling()
    // initial scan has usually completed by the time StationManager.init()
    // runs; if not, the 'changed' handlers above catch it moments later).
    this.recheckValidation()
  }

  /** Re-derives the current list of scanner/camera assignment problems
   *  (missing or duplicated) and, only when it actually changed, logs each
   *  one and emits 'validationChanged' for the renderer to pick up - see
   *  validateStations() for exactly what counts as an issue. */
  private recheckValidation(): void {
    const knownScannerIds = new Set(
      scannerManager
        .getLastKnownDevices()
        .filter((d) => d.connected)
        .map((d) => d.id)
    )
    const knownCameraIds = new Set(cameraManager.getLastKnownDevices().map((d) => d.id))
    const issues = validateStations(configManager.get().stations, knownScannerIds, knownCameraIds)

    const changed = JSON.stringify(issues) !== JSON.stringify(this.lastValidationIssues)
    this.lastValidationIssues = issues
    if (!changed) return

    if (issues.length === 0) {
      logger.info('Station validation: no issues')
    } else {
      for (const issue of issues) {
        logger.warn('Station validation issue', {
          stationId: issue.stationId,
          station: issue.stationName,
          type: issue.type
        })
      }
    }
    this.emit('validationChanged', issues)
  }

  getValidationIssues(): StationValidationIssue[] {
    return this.lastValidationIssues
  }

  /** Proactively surfaces "save folder became unavailable" (deleted, network
   *  share dropped, permissions changed) instead of only discovering it the
   *  next time someone tries to scan a barcode. */
  private async checkSaveLocationHealth(): Promise<void> {
    const status = await validateSaveLocation(configManager.getResolvedSaveLocation())
    const prev = this.lastSaveLocationStatus
    const changed = !prev || prev.exists !== status.exists || prev.writable !== status.writable || prev.path !== status.path
    this.lastSaveLocationStatus = status
    if (changed) {
      if (!status.writable) {
        logger.error('Save folder is unavailable', { path: status.path, error: status.error })
      } else if (prev) {
        logger.info('Save folder is available again', { path: status.path })
      }
      this.emit('saveLocationStatus', status)
    }
  }

  getSaveLocationStatus(): SaveLocationStatus | null {
    return this.lastSaveLocationStatus
  }

  /** Keeps runtime state in sync when stations are added/renamed/removed or
   *  reassigned to a different camera from the Settings page. */
  private reconcileStations(stations: StationConfig[]): void {
    const remainingIds = new Set(this.states.keys())

    for (const station of stations) {
      const scanner = resolveScannerDisplay(station)
      const camera = resolveCameraDisplay(station)
      if (!this.states.has(station.id)) {
        this.states.set(station.id, {
          stationId: station.id,
          status: 'idle',
          barcode: null,
          cameraName: camera.name,
          cameraConnected: camera.connected,
          scannerName: scanner.name,
          scannerConnected: scanner.connected,
          startedAt: null,
          elapsedSeconds: 0,
          lastError: null,
          dbId: null,
          videoPath: null
        })
        this.emit('stateChanged', this.publicState(station.id))
      } else {
        this.setState(station.id, {
          cameraName: camera.name,
          cameraConnected: camera.connected,
          scannerName: scanner.name,
          scannerConnected: scanner.connected
        })
      }
      remainingIds.delete(station.id)
    }

    for (const staleId of remainingIds) {
      const state = this.states.get(staleId)
      if (state && state.status !== 'recording') {
        this.states.delete(staleId)
        this.emit('stationRemoved', staleId)
      }
    }
  }

  private tick(): void {
    for (const [stationId, state] of this.states) {
      if (state.status === 'recording' && state.startedAt) {
        const elapsed = Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000)
        if (elapsed !== state.elapsedSeconds) {
          state.elapsedSeconds = elapsed
          this.emit('stateChanged', this.publicState(stationId))
        }
        this.checkDiskDuringRecording(stationId).catch((err) =>
          logger.error('Disk check failed', { error: (err as Error).message })
        )
      }
    }
  }

  private async checkDiskDuringRecording(stationId: string): Promise<void> {
    const station = this.getStationConfig(stationId)
    const saveLocation = station
      ? configManager.getResolvedSaveLocationForStation(station)
      : configManager.getResolvedSaveLocation()
    const usage = await getDiskUsage(saveLocation)
    if (usage.freeBytes < CRITICAL_DISK_STOP_BYTES) {
      logger.error('Disk critically low, safely stopping recording', { stationId, freeBytes: usage.freeBytes })
      await this.forceStopForSafety(stationId, 'Disk space critically low - recording stopped safely')
    }
  }

  private async forceStopForSafety(stationId: string, reason: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state || state.status !== 'recording') return
    overlayService.stop(stationId)
    await recordingEngine.stop(stationId)
    if (state.dbId && state.videoPath) {
      const thumb = await recordingEngine.generateThumbnail(state.videoPath)
      database.completeRecording(state.dbId, thumb)
    }
    this.writeMetadataFor(stationId, state)
    this.setState(stationId, {
      status: 'error',
      lastError: reason,
      barcode: null,
      startedAt: null,
      elapsedSeconds: 0,
      dbId: null,
      videoPath: null
    })
  }

  getStationConfig(stationId: string): StationConfig | undefined {
    return configManager.get().stations.find((s) => s.id === stationId)
  }

  getAllStates(): StationRuntimeState[] {
    return Array.from(this.states.keys()).map((id) => this.publicState(id))
  }

  private publicState(stationId: string): StationRuntimeState {
    const s = this.states.get(stationId)!
    const { dbId: _dbId, videoPath: _videoPath, ...rest } = s
    return rest
  }

  private setState(stationId: string, partial: Partial<StationRuntime>): void {
    const current = this.states.get(stationId)
    if (!current) return
    this.states.set(stationId, { ...current, ...partial })
    this.emit('stateChanged', this.publicState(stationId))
  }

  /** Resolves which station a scan actually belongs to. A scan from a
   *  physical scanner that's paired (via Raw Input device identification) to
   *  a specific station always wins, regardless of which station happens to
   *  be "active" in the UI. Unpaired/unidentified scans (deviceId is null -
   *  e.g. Raw Input unavailable, or the scanner hasn't been paired yet) fall
   *  back to the requested (active) station exactly as before. */
  private resolveTargetStationId(requestedStationId: string, deviceId: string | null): string {
    if (!deviceId) return requestedStationId
    const paired = configManager.get().stations.find((s) => s.scannerDeviceId === deviceId)
    return paired ? paired.id : requestedStationId
  }

  async handleScan(requestedStationId: string, barcode: string, deviceId: string | null = null): Promise<void> {
    const stationId = this.resolveTargetStationId(requestedStationId, deviceId)
    const state = this.states.get(stationId)
    const station = this.getStationConfig(stationId)
    if (!state || !station) {
      logger.warn('Scan received for unknown station', { stationId })
      return
    }

    if (!station.enabled) {
      logger.warn('Scan ignored: station is disabled', { stationId })
      return
    }

    if (state.status === 'recording') {
      if (state.barcode === barcode) {
        await this.stopRecording(stationId)
      } else {
        const event: WrongBarcodeEvent = { stationId, scannedBarcode: barcode, activeBarcode: state.barcode ?? '' }
        logger.warn('Wrong barcode scanned during active recording', { ...event })
        this.emit('wrongBarcode', event)
      }
      return
    }

    // idle or error state: attempt to start a new recording
    const saveLocation = configManager.getResolvedSaveLocationForStation(station)
    const existingFolder = path.join(saveLocation, barcode)
    const existingRow = database.findExistingByBarcode(barcode)
    const folderExists = fs.existsSync(existingFolder)

    if (folderExists || (existingRow && existingRow.status !== 'error')) {
      const event: DuplicateBarcodeEvent = { stationId, barcode, existingFolder }
      logger.info('Duplicate barcode scanned', { ...event })
      this.emit('duplicateBarcode', event)
      return
    }

    await this.startRecording(stationId, station, barcode, saveLocation)
  }

  private async startRecording(
    stationId: string,
    station: StationConfig,
    barcode: string,
    saveLocation: string
  ): Promise<void> {
    if (!station.cameraId && !station.cameraName) {
      this.setState(stationId, { status: 'error', lastError: 'No camera assigned to this station' })
      logger.error('Cannot start recording: no camera assigned', { stationId })
      return
    }

    // Resolved by unique device id (falling back to name only for a config
    // written before cameraId existed) - never by name alone, since two
    // identical camera models report the exact same friendly name and would
    // otherwise be indistinguishable here.
    const camera = cameraManager.resolveStationCamera(station)
    if (!camera) {
      this.setState(stationId, { status: 'error', lastError: 'Assigned camera is not connected' })
      logger.error('Cannot start recording: assigned camera is not connected', { stationId })
      return
    }
    const cameraDisplayName = buildCameraDisplayNames(cameraManager.getLastKnownDevices()).get(camera.id) ?? camera.name

    const preset = QUALITY_PRESETS[station.qualityPreset]
    const capabilities = await cameraManager.getCapabilities(camera.id)
    if (!isPresetSupported(preset, capabilities)) {
      const message = `กล้องนี้ไม่รองรับคุณภาพการบันทึก "${preset.label}" - เลือกคุณภาพอื่นในหน้าตั้งค่า`
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Cannot start recording: camera does not support selected quality preset', {
        stationId,
        preset: preset.id,
        cameraId: camera.id
      })
      return
    }

    const locationStatus = await validateSaveLocation(saveLocation)
    if (!locationStatus.exists || !locationStatus.writable) {
      const message = locationStatus.error ?? 'Save folder is unavailable - configure a valid folder in Settings'
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Refusing to start recording: save folder unusable', { stationId, ...locationStatus })
      return
    }

    const usage = await getDiskUsage(saveLocation)
    if (usage.freeBytes < CRITICAL_DISK_STOP_BYTES) {
      this.setState(stationId, { status: 'error', lastError: 'Disk space too low to start recording' })
      logger.error('Refusing to start recording: disk space too low', { stationId })
      return
    }

    const startedAt = new Date()
    const overlayConfig = configManager.get().overlay
    const overlay = overlayConfig.enabled
      ? {
          config: overlayConfig,
          textFilePath: overlayService.start(
            stationId,
            overlayConfig,
            { barcode, station: station.name, camera: cameraDisplayName },
            startedAt
          )
        }
      : null

    try {
      const result = await recordingEngine.start(station, camera.id, barcode, saveLocation, overlay)
      const dbId = database.insertRecordingStart({
        barcode,
        station: station.name,
        camera: cameraDisplayName,
        videoPath: result.videoPath,
        resolution: `${preset.width}x${preset.height}`,
        fps: station.fps,
        bitrateKbps: station.bitrateKbps
      })

      this.setState(stationId, {
        status: 'recording',
        barcode,
        cameraName: cameraDisplayName,
        startedAt: startedAt.toISOString(),
        elapsedSeconds: 0,
        lastError: null,
        dbId,
        videoPath: result.videoPath
      })
      logger.info('Recording started', { stationId, barcode, camera: cameraDisplayName, cameraId: camera.id })
    } catch (err) {
      overlayService.stop(stationId)
      const message = (err as Error).message
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Failed to start recording', { stationId, barcode, error: message })
    }
  }

  private async stopRecording(stationId: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state) return

    overlayService.stop(stationId)
    await recordingEngine.stop(stationId)

    let thumbnailPath: string | null = null
    if (state.videoPath) {
      thumbnailPath = await recordingEngine.generateThumbnail(state.videoPath)
    }
    if (state.dbId) {
      database.completeRecording(state.dbId, thumbnailPath)
    }
    this.writeMetadataFor(stationId, state)

    logger.info('Recording stopped', { stationId, barcode: state.barcode })

    this.setState(stationId, {
      status: 'idle',
      barcode: null,
      startedAt: null,
      elapsedSeconds: 0,
      dbId: null,
      videoPath: null,
      lastError: null
    })
  }

  /** Best-effort metadata.json write - skipped silently if the recording
   *  never got far enough to have a barcode/start time/output path. */
  private writeMetadataFor(stationId: string, state: StationRuntime): void {
    if (!state.videoPath || !state.startedAt || !state.barcode) return
    const station = this.getStationConfig(stationId)
    if (!station) return
    const resolution = QUALITY_PRESETS[station.qualityPreset]
    writeRecordingMetadata({
      videoPath: state.videoPath,
      barcode: state.barcode,
      station: station.name,
      camera: state.cameraName ?? station.cameraName ?? 'Unknown',
      startedAt: new Date(state.startedAt),
      endedAt: new Date(),
      resolution: `${resolution.width}x${resolution.height}`,
      fps: station.fps
    })
  }

  shutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.saveLocationHealthTimer) clearInterval(this.saveLocationHealthTimer)
    recordingEngine.killAll()
  }
}

/** Resolves a station's camera to a display name and connected status,
 *  disambiguated ("Camera Name (2)") when two connected cameras share a
 *  friendly name - see CameraManager.resolveStationCamera and
 *  buildCameraDisplayNames. Falls back to the raw configured name (with
 *  connected: false) when nothing currently connected matches, same as
 *  resolveScannerDisplay does for scanners. */
function resolveCameraDisplay(station: StationConfig): { id: string | null; name: string | null; connected: boolean } {
  if (!station.cameraId && !station.cameraName) return { id: null, name: null, connected: false }
  const device = cameraManager.resolveStationCamera(station)
  if (!device) return { id: null, name: station.cameraName, connected: false }
  const displayName = buildCameraDisplayNames(cameraManager.getLastKnownDevices()).get(device.id) ?? device.name
  return { id: device.id, name: displayName, connected: true }
}

function resolveScannerDisplay(station: StationConfig): { name: string | null; connected: boolean } {
  if (!station.scannerDeviceId) return { name: null, connected: false }
  const identified = configManager.get().identifiedScanners.find((s) => s.id === station.scannerDeviceId)
  const devices = scannerManager.getLastKnownDevices()
  const match = devices.find((d: ScannerDevice) => d.id === station.scannerDeviceId)
  return {
    name: identified?.name ?? match?.name ?? 'Paired scanner',
    connected: match?.connected ?? false
  }
}

export const stationManager = new StationManager()
