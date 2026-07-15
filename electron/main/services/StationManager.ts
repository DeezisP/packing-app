import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { configManager } from './ConfigManager'
import { database } from './Database'
import { recordingEngine } from './RecordingEngine'
import { cameraManager } from './CameraManager'
import { scannerManager } from './ScannerManager'
import { getDiskUsage, CRITICAL_DISK_STOP_BYTES } from './DiskMonitor'
import { validateSaveLocation } from './SaveLocationValidator'
import { logger } from './Logger'
import { RESOLUTION_PRESETS } from '@shared/types'
import type {
  StationRuntimeState,
  WrongBarcodeEvent,
  DuplicateBarcodeEvent,
  StationConfig,
  CameraDevice,
  ScannerDevice,
  SaveLocationStatus
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

  init(): void {
    for (const station of configManager.get().stations) {
      const scanner = resolveScannerDisplay(station)
      this.states.set(station.id, {
        stationId: station.id,
        status: 'idle',
        barcode: null,
        cameraName: station.cameraName,
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

    cameraManager.on('changed', ({ video }: { video: CameraDevice[] }) => {
      const connectedNames = new Set(video.map((d) => d.name))
      for (const [stationId, state] of this.states) {
        const connected = state.cameraName ? connectedNames.has(state.cameraName) : false
        if (connected !== state.cameraConnected) {
          this.setState(stationId, { cameraConnected: connected })
          if (connected) {
            logger.info('Camera reconnected', { stationId, camera: state.cameraName })
          } else {
            logger.warn('Camera disconnected', { stationId, camera: state.cameraName })
          }
        }
      }
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
    })

    configManager.on('changed', (cfg: { stations: StationConfig[] }) => this.reconcileStations(cfg.stations))
    // Re-check immediately when the save location itself changes, instead of
    // waiting up to SAVE_LOCATION_HEALTH_INTERVAL_MS for the next poll.
    configManager.on('changed', () => {
      this.checkSaveLocationHealth().catch((err) =>
        logger.error('Save location health check failed', { error: (err as Error).message })
      )
    })

    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
    this.saveLocationHealthTimer = setInterval(
      () => this.checkSaveLocationHealth().catch(() => undefined),
      SAVE_LOCATION_HEALTH_INTERVAL_MS
    )
    this.checkSaveLocationHealth().catch((err) =>
      logger.error('Initial save location health check failed', { error: (err as Error).message })
    )
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
      if (!this.states.has(station.id)) {
        this.states.set(station.id, {
          stationId: station.id,
          status: 'idle',
          barcode: null,
          cameraName: station.cameraName,
          cameraConnected: false,
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
          cameraName: station.cameraName,
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
    const usage = await getDiskUsage(configManager.getResolvedSaveLocation())
    if (usage.freeBytes < CRITICAL_DISK_STOP_BYTES) {
      logger.error('Disk critically low, safely stopping recording', { stationId, freeBytes: usage.freeBytes })
      await this.forceStopForSafety(stationId, 'Disk space critically low - recording stopped safely')
    }
  }

  private async forceStopForSafety(stationId: string, reason: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state || state.status !== 'recording') return
    await recordingEngine.stop(stationId)
    if (state.dbId && state.videoPath) {
      const thumb = await recordingEngine.generateThumbnail(state.videoPath)
      database.completeRecording(state.dbId, thumb)
    }
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
    const saveLocation = configManager.getResolvedSaveLocation()
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
    if (!station.cameraName) {
      this.setState(stationId, { status: 'error', lastError: 'No camera assigned to this station' })
      logger.error('Cannot start recording: no camera assigned', { stationId })
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

    try {
      const result = await recordingEngine.start(station, barcode, saveLocation)
      const resolution = RESOLUTION_PRESETS[station.resolutionPreset]
      const dbId = database.insertRecordingStart({
        barcode,
        station: station.name,
        camera: station.cameraName,
        videoPath: result.videoPath,
        resolution: `${resolution.width}x${resolution.height}`,
        fps: station.fps,
        bitrateKbps: station.bitrateKbps
      })

      this.setState(stationId, {
        status: 'recording',
        barcode,
        cameraName: station.cameraName,
        startedAt: new Date().toISOString(),
        elapsedSeconds: 0,
        lastError: null,
        dbId,
        videoPath: result.videoPath
      })
      logger.info('Recording started', { stationId, barcode, camera: station.cameraName })
    } catch (err) {
      const message = (err as Error).message
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Failed to start recording', { stationId, barcode, error: message })
    }
  }

  private async stopRecording(stationId: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state) return

    await recordingEngine.stop(stationId)

    let thumbnailPath: string | null = null
    if (state.videoPath) {
      thumbnailPath = await recordingEngine.generateThumbnail(state.videoPath)
    }
    if (state.dbId) {
      database.completeRecording(state.dbId, thumbnailPath)
    }

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

  shutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.saveLocationHealthTimer) clearInterval(this.saveLocationHealthTimer)
    recordingEngine.killAll()
  }
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
