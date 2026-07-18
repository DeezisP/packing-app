import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { configManager } from './ConfigManager'
import { database } from './Database'
import { recordingEngine } from './RecordingEngine'
import { liveRecordingService } from './LiveRecordingService'
import { cameraManager } from './CameraManager'
import { scannerManager } from './ScannerManager'
import { apiQueueService } from './ApiQueueService'
import { writeRecordingMetadata } from './MetadataService'
import { getDiskUsage, CRITICAL_DISK_STOP_BYTES } from './DiskMonitor'
import { validateSaveLocation } from './SaveLocationValidator'
import { logger } from './Logger'
import { QUALITY_PRESETS, buildCameraDisplayNames, validateStations, resolveRecordingMode } from '@shared/types'
import type {
  StationRuntimeState,
  WrongBarcodeEvent,
  DuplicateBarcodeEvent,
  StationConfig,
  ScannerDevice,
  SaveLocationStatus,
  StationValidationIssue,
  CameraPreviewReleaseRequest,
  CameraPreviewResumeSignal
} from '@shared/types'

const TICK_INTERVAL_MS = 1000
const SAVE_LOCATION_HEALTH_INTERVAL_MS = 10000
/** How long to wait for the renderer to ack a camera-release request before
 *  starting ffmpeg anyway - see requestPreviewRelease's doc comment. Well
 *  above what an actual track.stop()+IPC round trip needs, so this only
 *  matters when the renderer is slow/unresponsive/gone. */
const PREVIEW_RELEASE_ACK_TIMEOUT_MS = 2000
/** Extra margin after the release ack (or its timeout) before ffmpeg tries
 *  to open the device - Chromium's own capture pipeline teardown after
 *  track.stop() isn't necessarily complete the instant the renderer's ack
 *  fires, and this camera hardware has no tolerance for a second opener
 *  arriving too early (confirmed against real hardware: a second dshow open
 *  fails immediately if the first hasn't fully released). Cheap insurance -
 *  imperceptible against the rest of a barcode-scan-triggered start. */
const DEVICE_RELEASE_SETTLE_MS = 300
/** Disk is critically low during a force-stop-for-safety - still give
 *  ffmpeg a real (if short) chance to write a valid mp4 trailer rather than
 *  killing it instantly, since a killed-mid-write mp4 is exactly how the
 *  v1.6.2 incident produced an unplayable file - just don't wait as long as
 *  a normal stop does, given the urgency. */
const FORCE_STOP_TIMEOUT_MS = 3000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface StationRuntime extends StationRuntimeState {
  dbId: number | null
  videoPath: string | null
  /** CameraDevice.id the in-progress recording's capture session is tied to -
   *  recorded separately from the station's *configured* camera because that
   *  config could theoretically change mid-recording. Used to target the
   *  previewResume signal at the right camera once ffmpeg releases it - see
   *  activeSessionId for the field that actually correlates the ffmpeg
   *  process itself. Null whenever not recording. */
  activeCameraId: string | null
  /** Correlates this recording with the specific LiveRecordingService ffmpeg
   *  process handling it - never just `stationId` alone, since handleScan()
   *  already allows a new recording to start for a station whose previous
   *  one is still `status: 'processing'` (finalizing), and the two must
   *  never be confused with each other. Null whenever not recording. */
  activeSessionId: string | null
  /** The bitrate/mic settings actually used to start this capture, captured
   *  at start time rather than re-read from config at stop time - same
   *  reasoning as activeCameraId, config could change mid-recording. Null
   *  whenever not recording. */
  activeBitrateKbps: number | null
  activeMicName: string | null
  /** The negotiated width/height/fps this capture actually started ffmpeg
   *  with (post resolveRecordingMode, not just the station's configured
   *  preset) - carried through to finalizeStoppedRecording so
   *  verifyRecording can compare the *requested* mode against what the
   *  decoded file actually reports, instead of only ever logging what was
   *  asked for. Null whenever not recording. */
  activeWidth: number | null
  activeHeight: number | null
  activeFps: number | null
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
  /** Resolvers for in-flight camera-release requests, keyed by requestId -
   *  see requestPreviewRelease/resolvePreviewReleaseAck. */
  private pendingPreviewReleaseAcks = new Map<string, () => void>()

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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
    }

    // ffmpeg died mid-recording on its own (camera unplugged, driver crash,
    // etc.) rather than via a requested stop - see
    // LiveRecordingService.handleSessionExit. Guarded by sessionId, not just
    // stationId, so a stale error from an already-superseded session (see
    // activeSessionId's doc comment) can never clobber a newer recording
    // that's already underway.
    liveRecordingService.on('captureError', ({ sessionId, stationId, message }) => {
      const state = this.states.get(stationId)
      if (!state || state.activeSessionId !== sessionId) return
      if (state.dbId) database.markError(state.dbId, message)
      // ffmpeg has already exited, so the camera is free - give the live
      // preview it back instead of leaving it frozen through an error state.
      if (state.activeCameraId) {
        this.emit('previewResume', { stationId, cameraId: state.activeCameraId } satisfies CameraPreviewResumeSignal)
      }
      this.setState(stationId, {
        status: 'error',
        lastError: message,
        activeCameraId: null,
        activeSessionId: null,
        activeBitrateKbps: null,
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
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
          activeMicName: null,
          activeWidth: null,
          activeHeight: null,
          activeFps: null
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

  /** Tells the station's live camera preview to release its getUserMedia
   *  track for this camera and waits for the renderer's ack - see
   *  CameraPreviewReleaseRequest's doc comment for why this handshake exists
   *  at all (this exact camera hardware rejects a second concurrent open).
   *  Bounded by PREVIEW_RELEASE_ACK_TIMEOUT_MS so a slow or already-gone
   *  renderer can never block a recording start indefinitely; ffmpeg's own
   *  retry-on-busy in LiveRecordingService is the real backstop if release
   *  genuinely didn't happen in time. */
  private requestPreviewRelease(stationId: string, cameraId: string): Promise<void> {
    const requestId = randomUUID()
    const acked = new Promise<void>((resolve) => {
      this.pendingPreviewReleaseAcks.set(requestId, resolve)
    })
    this.emit('previewReleaseRequest', { requestId, stationId, cameraId } satisfies CameraPreviewReleaseRequest)
    const timedOut = delay(PREVIEW_RELEASE_ACK_TIMEOUT_MS)
    return Promise.race([acked, timedOut]).then(() => {
      this.pendingPreviewReleaseAcks.delete(requestId)
    })
  }

  /** Called from registerIpcHandlers.ts when the renderer acks a
   *  CameraPreviewReleaseRequest - see requestPreviewRelease. */
  resolvePreviewReleaseAck(requestId: string): void {
    const resolve = this.pendingPreviewReleaseAcks.get(requestId)
    if (!resolve) return
    this.pendingPreviewReleaseAcks.delete(requestId)
    resolve()
  }

  private async forceStopForSafety(stationId: string, reason: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state || state.status !== 'recording') return

    const sessionId = state.activeSessionId
    this.setState(stationId, { status: 'processing' })

    if (sessionId) {
      // Disk is critically low - still give ffmpeg a short, real chance to
      // write a valid mp4 trailer (see FORCE_STOP_TIMEOUT_MS) rather than
      // killing it instantly. The raw capture.mp4 is left on disk under its
      // temp name rather than renamed to the final videoPath - matches the
      // normal stop path's "never mark complete until verified" rule, just
      // without ever attempting that verification here since we're mid
      // emergency stop.
      await liveRecordingService.stopRecording(sessionId, FORCE_STOP_TIMEOUT_MS)
      if (state.activeCameraId) {
        this.emit('previewResume', { stationId, cameraId: state.activeCameraId } satisfies CameraPreviewResumeSignal)
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
      activeMicName: null,
      activeWidth: null,
      activeHeight: null,
      activeFps: null
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

    // Different camera models/drivers genuinely don't all support the same
    // modes - a probe failure here (ffmpeg missing, a transient dshow
    // hiccup) must never silently kill the whole recording attempt with an
    // unhandled rejection, so this is defensively caught rather than left to
    // propagate past this method the way it used to.
    let capabilities: Awaited<ReturnType<typeof cameraManager.getCapabilities>> = []
    try {
      capabilities = await cameraManager.getCapabilities(camera.id)
    } catch (err) {
      logger.warn('Camera capability probe failed, proceeding with the configured preset as requested', {
        stationId,
        cameraId: camera.id,
        error: (err as Error).message
      })
    }

    // A camera that can't do the exact configured preset (different model,
    // only does 4K at 15fps, etc.) no longer blocks recording outright -
    // the closest mode it actually supports is used instead. An empty
    // `capabilities` list (probe failed/inconclusive) fails open, requesting
    // the configured preset unchanged, same as before.
    const negotiated = resolveRecordingMode({ width: preset.width, height: preset.height, fps: station.fps }, capabilities)
    if (negotiated.width !== preset.width || negotiated.height !== preset.height || negotiated.fps !== station.fps) {
      logger.warn('Camera does not support the configured quality preset - using the closest supported mode', {
        stationId,
        cameraId: camera.id,
        preset: preset.id,
        requested: `${preset.width}x${preset.height}@${station.fps}`,
        negotiated: `${negotiated.width}x${negotiated.height}@${negotiated.fps}`
      })
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

      // This camera hardware cannot be opened by two processes at once
      // (confirmed against real hardware) - the renderer's live preview must
      // release it before ffmpeg can claim it for recording. See
      // requestPreviewRelease's doc comment for the timeout/settle reasoning.
      await this.requestPreviewRelease(stationId, camera.id)
      await delay(DEVICE_RELEASE_SETTLE_MS)

      const result = await liveRecordingService.startRecording({
        sessionId,
        stationId,
        cameraId: camera.id,
        micName: station.micName,
        width: negotiated.width,
        height: negotiated.height,
        fps: negotiated.fps,
        bitrateKbps: station.bitrateKbps,
        overlay,
        startedAt: startedAt.toISOString(),
        outputDir
      })

      if (!result.success) {
        const message = result.error ?? 'Failed to start recording'
        this.setState(stationId, { status: 'error', lastError: message })
        logger.error('Failed to start recording', { stationId, barcode, error: message })
        // Already released the preview above - ffmpeg never ended up
        // claiming the camera, so give it straight back.
        this.emit('previewResume', { stationId, cameraId: camera.id } satisfies CameraPreviewResumeSignal)
        return
      }

      // One consolidated, human-readable diagnostic block per recording
      // start - camera, what was asked for vs. what actually got used, and
      // the encoder - so troubleshooting a machine-specific issue never
      // requires piecing it together from several separate log lines. Same
      // multi-line-message-plus-structured-meta style this codebase already
      // uses for camera enumeration (see CameraManager.logEnumeration).
      logger.info(
        [
          'Recording diagnostics',
          `Camera: ${cameraDisplayName}`,
          `Requested: ${preset.width}x${preset.height} @ ${station.fps} FPS`,
          `Negotiated: ${negotiated.width}x${negotiated.height} @ ${negotiated.fps} FPS`,
          `Encoder: ${result.encoder}`,
          `Hardware Acceleration: ${result.encoder !== 'libx264' ? 'Enabled' : 'Disabled (CPU fallback)'}`
        ].join('\n'),
        {
          stationId,
          sessionId,
          cameraId: camera.id,
          requestedWidth: preset.width,
          requestedHeight: preset.height,
          requestedFps: station.fps,
          negotiatedWidth: negotiated.width,
          negotiatedHeight: negotiated.height,
          negotiatedFps: negotiated.fps,
          encoder: result.encoder,
          hardwareAccelerated: result.encoder !== 'libx264'
        }
      )

      const dbId = database.insertRecordingStart({
        barcode,
        station: station.name,
        camera: cameraDisplayName,
        videoPath,
        resolution: `${negotiated.width}x${negotiated.height}`,
        fps: negotiated.fps,
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
        activeMicName: station.micName,
        activeWidth: negotiated.width,
        activeHeight: negotiated.height,
        activeFps: negotiated.fps
      })
      logger.info('Recording started', {
        stationId,
        barcode,
        camera: cameraDisplayName,
        cameraId: camera.id,
        sessionId,
        success: true
      })

      // The warehouse API is only ever notified once a recording actually
      // finishes (see finalizeStoppedRecording's `enqueue('confirm', ...)`)
      // - starting a recording no longer reports anything upstream.
    } catch (err) {
      const message = (err as Error).message
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Failed to start recording', { stationId, barcode, error: message })
      // Best-effort: if this failed after the preview was already released
      // above, make sure it isn't left frozen forever.
      this.emit('previewResume', { stationId, cameraId: camera.id } satisfies CameraPreviewResumeSignal)
    }
  }

  private async stopRecording(stationId: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state) return

    const sessionId = state.activeSessionId
    logger.info('Recording stop: requested', { stationId, barcode: state.barcode, videoPath: state.videoPath, sessionId })

    // The live preview stays frozen (camera released to ffmpeg) until
    // finalizeStoppedRecording emits previewResume below, once ffmpeg has
    // actually exited. Flip to 'processing' immediately rather than leaving
    // the dashboard showing a frozen "Recording" timer for the verify/DB/
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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
    }
  }

  private async finalizeStoppedRecording(stationId: string, state: StationRuntime, sessionId: string): Promise<void> {
    const stopResult = await liveRecordingService.stopRecording(sessionId)

    // ffmpeg has now fully released the device (its process has exited)
    // regardless of whether the stop itself was graceful - safe to hand the
    // live preview its camera back immediately, before the verify/thumbnail
    // work below even starts, so the operator sees it live again as soon as
    // possible rather than waiting on file finalization.
    if (state.activeCameraId) {
      this.emit('previewResume', { stationId, cameraId: state.activeCameraId } satisfies CameraPreviewResumeSignal)
    }

    const station = this.getStationConfig(stationId)

    if (!state.videoPath) {
      const message = 'ไม่พบตำแหน่งไฟล์วิดีโอสำหรับการบันทึกนี้'
      if (state.dbId) database.markError(state.dbId, message)
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: no videoPath recorded for this session', { stationId, barcode: state.barcode, sessionId })
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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    const capturePath = path.join(path.dirname(state.videoPath), 'capture.mp4')

    if (!stopResult.success) {
      const message = stopResult.error ?? 'การบันทึกวิดีโอล้มเหลว'
      if (state.dbId) database.markError(state.dbId, message)
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: ffmpeg reported failure, raw capture (if any) preserved', {
        stationId,
        barcode: state.barcode,
        capturePath,
        error: stopResult.error
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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    // ffmpeg already wrote the final-quality H.264 mp4 directly - no
    // separate transcode pass anymore (see LiveRecordingService). Only
    // promote it to the final videoPath after everything below proves it
    // good, same "never mark complete until verified" rule the old
    // transcode step followed, just via a rename instead of a re-encode.
    try {
      fs.renameSync(capturePath, state.videoPath)
    } catch (err) {
      const message = (err as Error).message
      if (state.dbId) database.markError(state.dbId, message)
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: failed to finalize captured file', {
        stationId,
        barcode: state.barcode,
        capturePath,
        error: message
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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    // The file on disk isn't trustworthy just because ffmpeg exited 0 - same
    // lesson the old pipeline already learned the hard way: only actually
    // decoding it proves it's playable. Passing the negotiated width/height/
    // fps lets verifyRecording cross-check what was actually written against
    // what this capture was started with, instead of only ever trusting the
    // pre-flight negotiation (see its own doc comment for why that's not the
    // same guarantee - the negotiation happens before ffmpeg ever opens the
    // camera).
    const expectedMode =
      state.activeWidth !== null && state.activeHeight !== null && state.activeFps !== null
        ? { width: state.activeWidth, height: state.activeHeight, fps: state.activeFps }
        : undefined
    const verification = await recordingEngine.verifyRecording(state.videoPath, expectedMode)
    logger.info('File finalization: recording verified', {
      stationId,
      barcode: state.barcode,
      videoPath: state.videoPath,
      valid: verification.valid,
      sizeBytes: verification.sizeBytes,
      durationSeconds: verification.durationSeconds,
      requestedResolution: expectedMode ? `${expectedMode.width}x${expectedMode.height}` : null,
      requestedFps: expectedMode?.fps ?? null,
      actualResolution: verification.actualWidth !== null && verification.actualHeight !== null
        ? `${verification.actualWidth}x${verification.actualHeight}`
        : null,
      actualFps: verification.actualFps,
      actualCodec: verification.actualCodec
    })

    if (!verification.valid) {
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
        activeMicName: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    const thumbnailPath = await recordingEngine.generateThumbnail(state.videoPath)
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
      activeMicName: null,
      activeWidth: null,
      activeHeight: null,
      activeFps: null
    })
  }

  /** Recording lives entirely in the main process now - ffmpeg opens the
   *  camera and encodes independently of the renderer (see
   *  LiveRecordingService), so a renderer crash no longer interrupts an
   *  in-progress recording at all; it keeps running untouched. The only
   *  effect a renderer crash has here is that the *live preview* for any
   *  camera currently locked by an active recording will simply fail to
   *  reattach when the new renderer window mounts (the existing "preview
   *  unavailable" UI already handles a failed getUserMedia attach) until the
   *  recording finishes and the normal previewResume signal fires.
   *
   *  Still worth resolving any in-flight preview-release acks immediately
   *  (rather than letting them sit out their full timeout) since we already
   *  know for certain no renderer is left to answer them. Called from
   *  main/index.ts's render-process-gone listener, before the window is
   *  recreated. */
  handleRendererGone(): void {
    for (const resolve of this.pendingPreviewReleaseAcks.values()) resolve()
    this.pendingPreviewReleaseAcks.clear()
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
    liveRecordingService.killAll()
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
