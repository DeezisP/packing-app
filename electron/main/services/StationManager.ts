import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { configManager } from './ConfigManager'
import { database } from './Database'
import { recordingEngine } from './RecordingEngine'
import { captureIngestService } from './CaptureIngestService'
import { cameraManager } from './CameraManager'
import { scannerManager } from './ScannerManager'
import { apiQueueService } from './ApiQueueService'
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
  StationValidationIssue,
  CaptureBeginPayload,
  CaptureEndPayload
} from '@shared/types'

const TICK_INTERVAL_MS = 1000
const SAVE_LOCATION_HEALTH_INTERVAL_MS = 10000

interface StationRuntime extends StationRuntimeState {
  dbId: number | null
  videoPath: string | null
  /** CameraDevice.id the in-progress recording's capture session is tied to -
   *  recorded separately from the station's *configured* camera because that
   *  config could theoretically change mid-recording. Kept for logging/
   *  display only now - see activeSessionId for the field that actually
   *  correlates capture chunks/transcode. Null whenever not recording. */
  activeCameraId: string | null
  /** Correlates this recording's capture chunks (see CaptureIngestService)
   *  and its eventual transcode with exactly this attempt - never just
   *  `stationId` alone, since handleScan() already allows a new recording to
   *  start for a station whose previous one is still `status: 'processing'`
   *  (finalizing), and the two must never be confused with each other. Null
   *  whenever not recording. */
  activeSessionId: string | null
  /** The bitrate/mic settings actually used to start this capture, captured
   *  at start time rather than re-read from config at stop time - same
   *  reasoning as activeCameraId, config could change mid-recording. Null
   *  whenever not recording. */
  activeBitrateKbps: number | null
  activeMicName: string | null
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
        videoPath: null,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
    }

    // Renderer-reported hard failure of the live capture (mic device
    // missing, unsupported MediaRecorder mimeType, camera track ended
    // unexpectedly) - see CaptureIngestService.reportCaptureError. Guarded
    // by sessionId, not just stationId, so a stale error from an
    // already-superseded session (see activeSessionId's doc comment) can
    // never clobber a newer recording that's already underway.
    captureIngestService.on('captureError', ({ sessionId, stationId, message }) => {
      const state = this.states.get(stationId)
      if (!state || state.activeSessionId !== sessionId) return
      if (state.dbId) database.markError(state.dbId, message)
      this.setState(stationId, {
        status: 'error',
        lastError: message,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
      logger.error('Recording stopped unexpectedly', { stationId, sessionId, message })
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
          videoPath: null,
          activeCameraId: null,
          activeSessionId: null,
          activeBitrateKbps: null,
          activeMicName: null
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

    const sessionId = state.activeSessionId
    this.setState(stationId, { status: 'processing' })

    if (sessionId) {
      try {
        this.emit('captureStop', { sessionId, stationId } satisfies CaptureEndPayload)
        // Disk is critically low - never attempt a transcode here, it needs
        // *more* free space, not less, and generateThumbnail/completeRecording
        // both need a finished mp4 that doesn't exist yet (only capture.webm
        // does at this point). Finalize immediately (no wait for the renderer
        // to confirm) and leave the raw capture on disk rather than lose it -
        // it's never auto-deleted, unlike the intermediate file on a normal
        // successful stop.
        await captureIngestService.endSession(sessionId, 0)
      } catch (err) {
        // Never let this leave the station stuck in 'processing' - we're
        // already mid-emergency-stop, so just log and fall through to the
        // same error state below regardless.
        logger.error('Force-stop: failed to finalize capture session', { stationId, sessionId, error: (err as Error).message })
      }
    }

    if (state.dbId) database.markError(state.dbId, reason)
    this.writeMetadataFor(stationId, state)
    this.setState(stationId, {
      status: 'error',
      lastError: reason,
      barcode: null,
      startedAt: null,
      elapsedSeconds: 0,
      dbId: null,
      videoPath: null,
      activeCameraId: null,
      activeSessionId: null,
      activeBitrateKbps: null,
      activeMicName: null
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
    logger.info('Recording start: requested', {
      stationId,
      station: station.name,
      barcode,
      scanner: resolveScannerDisplay(station).name
    })

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
      ? { config: overlayConfig, staticData: { barcode, station: station.name, camera: cameraDisplayName } }
      : null

    const outputDir = path.join(saveLocation, barcode)
    const videoPath = path.join(outputDir, 'packing.mp4')
    const sessionId = randomUUID()

    try {
      fs.mkdirSync(outputDir, { recursive: true })
      captureIngestService.beginSession({ sessionId, stationId, outputDir })

      const dbId = database.insertRecordingStart({
        barcode,
        station: station.name,
        camera: cameraDisplayName,
        videoPath,
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
        videoPath,
        activeCameraId: camera.id,
        activeSessionId: sessionId,
        activeBitrateKbps: station.bitrateKbps,
        activeMicName: station.micName
      })
      logger.info('Recording started', {
        stationId,
        barcode,
        camera: cameraDisplayName,
        cameraId: camera.id,
        sessionId,
        success: true
      })

      // Tells the station's already-live camera preview to start capturing
      // its own already-open MediaStream - the camera itself is never
      // reopened or renegotiated, see CaptureIngestService/useRecordingCapture.
      this.emit('captureStart', {
        sessionId,
        stationId,
        cameraId: camera.id,
        micName: station.micName,
        preset: { width: preset.width, height: preset.height, fps: station.fps, bitrateKbps: station.bitrateKbps },
        overlay,
        startedAt: startedAt.toISOString()
      } satisfies CaptureBeginPayload)

      apiQueueService.enqueue('scan', barcode, resolveScannerDisplay(station).name ?? station.name, station.name)
    } catch (err) {
      const message = (err as Error).message
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Failed to start recording', { stationId, barcode, error: message })
    }
  }

  private async stopRecording(stationId: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state) return

    const sessionId = state.activeSessionId
    logger.info('Recording stop: requested', { stationId, barcode: state.barcode, videoPath: state.videoPath, sessionId })

    // The live preview is never touched by any of this - it was never given
    // up in the first place (see CaptureIngestService's class doc comment).
    // Flip to 'processing' immediately rather than leaving the dashboard
    // showing a frozen "Recording" timer for the transcode/verify/DB/
    // metadata work still happening below.
    this.setState(stationId, { status: 'processing' })

    if (!sessionId) {
      // Nothing was actually capturing (shouldn't happen via the normal
      // barcode-driven stop path) - defensive, matches the rest of this
      // state machine's style rather than leaving the station stuck.
      this.setState(stationId, {
        status: 'idle',
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
      return
    }

    try {
      await this.finalizeStoppedRecording(stationId, state, sessionId)
    } catch (err) {
      // Anything unexpected here (not just the explicitly-handled transcode/
      // verify/disk-space branches inside finalizeStoppedRecording, which
      // already resolve to their own clean error state) must never leave a
      // station stuck in 'processing' forever - that would mean it can
      // never record again without restarting the app.
      const message = (err as Error).message
      logger.error('Recording stop: unexpected failure during finalize, forcing station back to error state', {
        stationId,
        barcode: state.barcode,
        sessionId,
        error: message
      })
      if (state.dbId) database.markError(state.dbId, message)
      this.setState(stationId, {
        status: 'error',
        lastError: message,
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
    }
  }

  private async finalizeStoppedRecording(stationId: string, state: StationRuntime, sessionId: string): Promise<void> {
    this.emit('captureStop', { sessionId, stationId } satisfies CaptureEndPayload)
    const { capturePath, bytesWritten } = await captureIngestService.endSession(sessionId)

    const station = this.getStationConfig(stationId)
    const saveLocation = station
      ? configManager.getResolvedSaveLocationForStation(station)
      : configManager.getResolvedSaveLocation()

    // Finishing briefly needs headroom for the finished mp4 alongside the
    // still-on-disk capture.webm - a consideration the old single-output
    // ffmpeg pipeline never had, since it only ever wrote one file. Sized
    // off the actual capture rather than a flat constant since it scales
    // with recording length/quality.
    const usage = await getDiskUsage(saveLocation)
    if (usage.freeBytes < bytesWritten + CRITICAL_DISK_STOP_BYTES) {
      const message = 'พื้นที่ดิสก์ไม่เพียงพอสำหรับประมวลผลไฟล์วิดีโอ - ไฟล์ต้นฉบับถูกเก็บไว้แล้ว'
      if (state.dbId) database.markError(state.dbId, message)
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: insufficient disk space to transcode, raw capture preserved', {
        stationId,
        barcode: state.barcode,
        capturePath,
        bytesWritten,
        freeBytes: usage.freeBytes
      })
      this.setState(stationId, {
        status: 'error',
        lastError: message,
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
      return
    }

    // One-shot, non-live transcode of the completed capture file - the
    // overlay (if any) is already burned in by the renderer's canvas
    // compositing before this ever runs, see useRecordingCapture.ts.
    const transcode = state.videoPath
      ? await captureIngestService.transcodeToMp4({
          sessionId,
          capturePath,
          outputPath: state.videoPath,
          bitrateKbps: state.activeBitrateKbps ?? QUALITY_PRESETS['1080p30'].bitrateKbps,
          hasAudio: state.activeMicName !== null
        })
      : { success: false, error: 'ไม่พบตำแหน่งไฟล์วิดีโอสำหรับการบันทึกนี้' }

    if (!transcode.success) {
      if (state.dbId) database.markError(state.dbId, transcode.error ?? 'แปลงไฟล์วิดีโอไม่สำเร็จ')
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: transcode failed, raw capture preserved', {
        stationId,
        barcode: state.barcode,
        capturePath,
        error: transcode.error
      })
      this.setState(stationId, {
        status: 'error',
        lastError: transcode.error ?? 'แปลงไฟล์วิดีโอไม่สำเร็จ',
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
      return
    }

    // The file on disk isn't trustworthy just because the transcode exited
    // 0 - same lesson as the old live-ffmpeg pipeline, just at a different
    // stage: only actually decoding it proves it's playable.
    const verification = state.videoPath ? await recordingEngine.verifyRecording(state.videoPath) : null
    logger.info('File finalization: recording verified', {
      stationId,
      barcode: state.barcode,
      videoPath: state.videoPath,
      valid: verification?.valid ?? false,
      sizeBytes: verification?.sizeBytes ?? 0,
      durationSeconds: verification?.durationSeconds ?? null
    })

    if (verification && !verification.valid) {
      if (state.dbId) database.markError(state.dbId, verification.error ?? 'ไฟล์วิดีโอเสียหาย')
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: file failed verification, not marked as completed', {
        stationId,
        barcode: state.barcode,
        videoPath: state.videoPath,
        error: verification.error
      })
      this.setState(stationId, {
        status: 'error',
        lastError: verification.error ?? 'ไฟล์วิดีโอเสียหายหรือไม่สามารถเล่นได้',
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null
      })
      return
    }

    // Only delete the raw capture once the final mp4 is proven good -
    // best-effort, never blocks finishing the recording if cleanup fails.
    fs.unlink(capturePath, (err) => {
      if (err) logger.warn('Failed to delete intermediate capture file', { capturePath, error: err.message })
    })

    let thumbnailPath: string | null = null
    if (state.videoPath) {
      thumbnailPath = await recordingEngine.generateThumbnail(state.videoPath)
    }
    if (state.dbId) {
      database.completeRecording(state.dbId, thumbnailPath)
    }
    this.writeMetadataFor(stationId, state)

    logger.info('Recording stopped', { stationId, barcode: state.barcode })

    if (state.barcode) {
      const scannerDevice = (station ? resolveScannerDisplay(station).name : null) ?? station?.name ?? stationId
      apiQueueService.enqueue('confirm', state.barcode, scannerDevice, station?.name ?? stationId)
    }

    this.setState(stationId, {
      status: 'idle',
      barcode: null,
      startedAt: null,
      elapsedSeconds: 0,
      dbId: null,
      videoPath: null,
      lastError: null,
      activeCameraId: null,
      activeSessionId: null,
      activeBitrateKbps: null,
      activeMicName: null
    })
  }

  /** Best-effort salvage when the renderer process itself dies mid-recording
   *  (GPU crash, Chromium bug, OOM) - the one genuine new failure mode this
   *  architecture accepts, since the live capture leg is renderer-owned (see
   *  CaptureIngestService's class doc comment). There is definitively no
   *  renderer left to ever send a final chunk, so this runs the normal stop
   *  pipeline immediately on every station still actively 'recording' -
   *  CaptureIngestService.endSession's own timeout fallback finalizes with
   *  whatever bytes already arrived, and the existing transcode/verify
   *  failure paths already handle a truncated capture correctly. Stations
   *  already 'processing' are deliberately left alone here - their own
   *  in-flight stopRecording() call will hit that same timeout fallback on
   *  its own; calling stopRecording() a second time concurrently for the
   *  same station would race it. Called from main/index.ts's
   *  render-process-gone listener, before the window is recreated. */
  handleRendererGone(): void {
    for (const [stationId, state] of this.states) {
      if (state.status !== 'recording' || !state.activeSessionId) continue
      logger.error('Renderer process gone mid-recording, salvaging partial capture', {
        stationId,
        sessionId: state.activeSessionId,
        barcode: state.barcode
      })
      this.stopRecording(stationId).catch((err) =>
        logger.error('Failed to salvage recording after renderer crash', { stationId, error: (err as Error).message })
      )
    }
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
    captureIngestService.killAll()
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
