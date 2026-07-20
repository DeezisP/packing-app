import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { configManager } from './ConfigManager'
import { database } from './Database'
import { recordingEngine } from './RecordingEngine'
import { persistentCaptureService } from './PersistentCaptureService'
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
  CameraCapabilityOption
} from '@shared/types'

const TICK_INTERVAL_MS = 1000
const SAVE_LOCATION_HEALTH_INTERVAL_MS = 10000
/** Backoff for the tick()-driven capture self-heal (see maybeRetryCapture) -
 *  starts quick (a transient driver hiccup should recover fast) and doubles
 *  up to a ceiling so a camera that's genuinely gone for a long time (really
 *  unplugged, not coming back soon) doesn't get hammered with an ffmpeg
 *  spawn attempt every single tick indefinitely. */
const CAPTURE_RETRY_INITIAL_MS = 3000
const CAPTURE_RETRY_MAX_MS = 30000

interface StationRuntime extends StationRuntimeState {
  dbId: number | null
  videoPath: string | null
  /** The CameraDevice.id PersistentCaptureService currently has a session
   *  open for on this station's behalf - independent of whether a recording
   *  is active (the session runs continuously; see PersistentCaptureService).
   *  Null until the first successful start, or if the camera is
   *  unassigned/disconnected/disabled. */
  capturedCameraId: string | null
  /** CameraDevice.id the in-progress *recording* is against - a snapshot of
   *  capturedCameraId at the moment recording started, since a config change
   *  mid-recording must never retarget an already-running finalize. Null
   *  whenever not recording. */
  activeCameraId: string | null
  /** The negotiated width/height/fps this station's persistent capture
   *  session was actually running at when this recording started - carried
   *  through to finalizeStoppedRecording so verifyRecording can compare the
   *  decoded file's real mode against it. Null whenever not recording. */
  activeWidth: number | null
  activeHeight: number | null
  activeFps: number | null
}

/** The barcode-driven state machine described in the spec:
 *  first scan of a barcode starts recording, second scan of the SAME barcode
 *  stops it, a different barcode while recording is rejected ("wrong barcode"),
 *  and a barcode that already has a folder on disk triggers a duplicate prompt
 *  instead of silently overwriting anything. Every station runs this
 *  independently so Station A and Station B never interfere with each other.
 *
 *  Camera ownership is entirely decoupled from this state machine now (see
 *  PersistentCaptureService) - a station's camera is captured continuously
 *  for as long as it's enabled+assigned+connected, never just while
 *  `status === 'recording'`. Starting/stopping a recording only ever marks
 *  which already-flowing segments belong to it; it never opens, closes, or
 *  restarts the camera itself. */
class StationManager extends EventEmitter {
  private states = new Map<string, StationRuntime>()
  private tickTimer: NodeJS.Timeout | null = null
  private saveLocationHealthTimer: NodeJS.Timeout | null = null
  private lastSaveLocationStatus: SaveLocationStatus | null = null
  /** Per-station backoff state for the tick()-driven capture self-heal (see
   *  maybeRetryCapture) - absent entirely means "no retry currently
   *  outstanding," cleared on a successful reconcile. */
  private captureRetry = new Map<string, { nextAttemptAt: number; delayMs: number }>()
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
        capturedCameraId: null,
        activeCameraId: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
    }

    // The persistent capture process for a camera died on its own (unplugged,
    // driver crash) rather than via a requested stop. Matched against every
    // station whose *current* capturedCameraId or in-progress recording
    // points at this camera - a station reassigned to a different camera in
    // the meantime is correctly left alone.
    persistentCaptureService.on('captureError', ({ cameraId, message }) => {
      for (const [stationId, state] of this.states) {
        if (state.capturedCameraId !== cameraId && state.activeCameraId !== cameraId) continue
        if (state.status === 'recording' || state.status === 'processing') {
          if (state.dbId) database.markError(state.dbId, message)
          this.writeMetadataFor(stationId, state)
        }
        this.setState(stationId, {
          status: 'error',
          lastError: message,
          barcode: null,
          startedAt: null,
          elapsedSeconds: 0,
          dbId: null,
          videoPath: null,
          capturedCameraId: null,
          activeCameraId: null,
          activeWidth: null,
          activeHeight: null,
          activeFps: null
        })
        logger.error('Persistent capture stopped unexpectedly', { stationId, cameraId, message })
        this.reconcileCaptureForStation(stationId).catch(() => undefined)
      }
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
        this.reconcileCaptureForStation(stationId).catch((err) =>
          logger.error('Persistent capture reconcile failed', { stationId, error: (err as Error).message })
        )
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

    // Kick off persistent capture for every station whose camera is already
    // known to be connected - fire-and-forget, each station's own capture
    // status update flows back through setState/stateChanged as it resolves.
    for (const stationId of this.states.keys()) {
      this.reconcileCaptureForStation(stationId).catch((err) =>
        logger.error('Persistent capture reconcile failed', { stationId, error: (err as Error).message })
      )
    }
  }

  /** Starts, stops, or restarts this station's persistent capture session
   *  so it matches what the station is currently configured for (enabled,
   *  camera assignment, quality preset, overlay). Never touches a station
   *  mid-recording - the camera/config that started an in-progress
   *  recording stays exactly as it was until that recording finishes, at
   *  which point this is called again and catches up on anything deferred. */
  private async reconcileCaptureForStation(stationId: string): Promise<void> {
    const station = this.getStationConfig(stationId)
    const state = this.states.get(stationId)
    if (!station || !state) return
    if (state.status === 'recording' || state.status === 'processing') return

    const camera = station.enabled ? cameraManager.resolveStationCamera(station) : null
    const desiredCameraId = camera?.id ?? null

    if (state.capturedCameraId && state.capturedCameraId !== desiredCameraId) {
      await persistentCaptureService.stop(state.capturedCameraId)
      this.setState(stationId, { capturedCameraId: null })
    }

    if (!desiredCameraId || !camera) return
    if (persistentCaptureService.isActive(desiredCameraId) && state.capturedCameraId === desiredCameraId) return

    const preset = QUALITY_PRESETS[station.qualityPreset]
    let capabilities: CameraCapabilityOption[] = []
    try {
      capabilities = await cameraManager.getCapabilities(camera.id)
    } catch (err) {
      logger.warn('Camera capability probe failed, proceeding with the configured preset as requested', {
        stationId,
        cameraId: camera.id,
        error: (err as Error).message
      })
    }
    const negotiated = resolveRecordingMode({ width: preset.width, height: preset.height, fps: station.fps }, capabilities)
    const cameraDisplayName = buildCameraDisplayNames(cameraManager.getLastKnownDevices()).get(camera.id) ?? camera.name
    const overlayConfig = configManager.get().overlay
    const overlay = overlayConfig.enabled ? { config: overlayConfig, staticData: { station: station.name, camera: cameraDisplayName } } : null

    const result = await persistentCaptureService.start({
      cameraId: camera.id,
      stationId,
      micName: station.micName,
      width: negotiated.width,
      height: negotiated.height,
      fps: negotiated.fps,
      bitrateKbps: station.bitrateKbps,
      overlay
    })

    // A station could have been reassigned to a different camera (or
    // disabled) while this async start was in flight - re-check before
    // touching state so a slow/failed start for a since-abandoned camera
    // never clobbers whatever the station has already moved on to.
    const current = this.states.get(stationId)
    if (!current || this.getStationConfig(stationId)?.cameraId !== station.cameraId) return

    if (result.success) {
      // Clears any backoff the tick()-driven self-heal had built up for this
      // station (see maybeRetryCapture) - a fresh session just started
      // successfully, so the next failure (if any) should start the ramp
      // over rather than inheriting a long-since-irrelevant delay. Also
      // clears a stale 'error' status left over from whatever caused this
      // station to need reconciling in the first place (a captureError
      // event, or a previous failed retry) - without this, a station that
      // silently self-heals would keep showing 'error' in the UI forever
      // even though capture is working again, which defeats the point of
      // recovering without a restart at all.
      this.captureRetry.delete(stationId)
      this.setState(stationId, {
        capturedCameraId: camera.id,
        cameraConnected: true,
        cameraName: cameraDisplayName,
        ...(current.status === 'error' ? { status: 'idle', lastError: null } : {})
      })
      logger.info('Persistent capture: session ready', {
        stationId,
        cameraId: camera.id,
        camera: cameraDisplayName,
        negotiatedWidth: negotiated.width,
        negotiatedHeight: negotiated.height,
        negotiatedFps: negotiated.fps,
        encoder: result.encoder,
        hardwareAccelerated: result.encoder !== 'libx264',
        recoveredFromError: current.status === 'error'
      })
    } else {
      logger.error('Persistent capture: failed to start', { stationId, cameraId: camera.id, error: result.error })
      this.setState(stationId, { status: 'error', lastError: result.error ?? 'Failed to start camera capture' })
    }
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
          capturedCameraId: null,
          activeCameraId: null,
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
      this.reconcileCaptureForStation(station.id).catch((err) =>
        logger.error('Persistent capture reconcile failed', { stationId: station.id, error: (err as Error).message })
      )
    }

    for (const staleId of remainingIds) {
      const state = this.states.get(staleId)
      if (state && state.status !== 'recording') {
        if (state.capturedCameraId) persistentCaptureService.stop(state.capturedCameraId).catch(() => undefined)
        this.states.delete(staleId)
        this.captureRetry.delete(staleId)
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
      this.maybeRetryCapture(stationId, state)
    }
  }

  /** Self-heal for a persistent capture session that's gone missing without
   *  anything else noticing. reconcileCaptureForStation is already called
   *  from several event-driven triggers (camera list changes, config
   *  changes, a captureError event), but none of those fire for the case
   *  that actually needs recovering: the capture ffmpeg process dying on its
   *  own (crash, driver fault, a momentary glitch) while the camera stays
   *  physically connected and enumerated - cameraManager's device list never
   *  changes, so its 'changed' event never fires, and nothing else was
   *  watching. Before this, the only way to recover was restarting the app
   *  (which re-runs reconcileCaptureForStation for every station fresh at
   *  startup). Running this every tick (1s) catches that case within a few
   *  seconds instead, without needing to hook every possible way a session
   *  can die.
   *
   *  Backed off per station (not attempted every single tick) so a camera
   *  that's genuinely gone for a while doesn't get an ffmpeg spawn attempt
   *  every second indefinitely - see CAPTURE_RETRY_INITIAL_MS/_MAX_MS. The
   *  backoff is cleared entirely once reconcileCaptureForStation actually
   *  succeeds (see its success branch), so a camera that comes back quickly
   *  recovers quickly too, not on whatever the backoff had ramped up to. */
  private maybeRetryCapture(stationId: string, state: StationRuntime): void {
    if (state.status === 'recording' || state.status === 'processing') return
    const station = this.getStationConfig(stationId)
    if (!station || !station.enabled) return
    const camera = cameraManager.resolveStationCamera(station)
    // No connected camera to even try - cameraManager's own 'changed' event
    // already covers "camera reappeared," this only needs to handle "camera
    // is right there but the session isn't."
    if (!camera) return
    if (persistentCaptureService.isActive(camera.id) && state.capturedCameraId === camera.id) return

    const now = Date.now()
    const retry = this.captureRetry.get(stationId)
    if (retry && now < retry.nextAttemptAt) return

    const delayMs = retry ? Math.min(retry.delayMs * 2, CAPTURE_RETRY_MAX_MS) : CAPTURE_RETRY_INITIAL_MS
    this.captureRetry.set(stationId, { nextAttemptAt: now + delayMs, delayMs })

    this.reconcileCaptureForStation(stationId).catch((err) =>
      logger.error('Persistent capture self-heal retry failed', { stationId, error: (err as Error).message })
    )
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

    this.setState(stationId, { status: 'processing' })
    try {
      await this.finalizeStoppedRecording(stationId, state)
    } catch (err) {
      logger.error('Force-stop finalize failed', { stationId, error: (err as Error).message })
    }
    const current = this.states.get(stationId)
    if (current && current.status !== 'error') {
      if (current.dbId) database.markError(current.dbId, reason)
    }
    this.setState(stationId, { status: 'error', lastError: reason })
    this.reconcileCaptureForStation(stationId).catch(() => undefined)
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

    const state = this.states.get(stationId)!
    const cameraId = state.capturedCameraId

    if (!cameraId || !persistentCaptureService.isActive(cameraId)) {
      const message = station.cameraId || station.cameraName ? 'Camera is not ready yet - try again in a moment' : 'No camera assigned to this station'
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Cannot start recording: camera capture is not active', { stationId, cameraId })
      return
    }

    const mode = persistentCaptureService.getMode(cameraId)

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
    const outputDir = path.join(saveLocation, barcode)
    const videoPath = path.join(outputDir, 'packing.mp4')
    const cameraDisplayName = state.cameraName ?? station.cameraName ?? 'Unknown'

    try {
      fs.mkdirSync(outputDir, { recursive: true })

      const marked = persistentCaptureService.markRecordingStart(cameraId, barcode)
      if (!marked) {
        const message = 'Camera capture has no data yet - try again in a moment'
        this.setState(stationId, { status: 'error', lastError: message })
        logger.error('Cannot start recording: no segments captured yet', { stationId, cameraId })
        return
      }

      logger.info(
        [
          'Recording diagnostics',
          `Camera: ${cameraDisplayName}`,
          `Requested: ${QUALITY_PRESETS[station.qualityPreset].width}x${QUALITY_PRESETS[station.qualityPreset].height} @ ${station.fps} FPS`,
          `Negotiated: ${mode ? `${mode.width}x${mode.height} @ ${mode.fps} FPS` : 'unknown'}`
        ].join('\n'),
        { stationId, cameraId, barcode, negotiated: mode }
      )

      const dbId = database.insertRecordingStart({
        barcode,
        station: station.name,
        camera: cameraDisplayName,
        videoPath,
        resolution: mode ? `${mode.width}x${mode.height}` : `${QUALITY_PRESETS[station.qualityPreset].width}x${QUALITY_PRESETS[station.qualityPreset].height}`,
        fps: mode?.fps ?? station.fps,
        bitrateKbps: station.bitrateKbps
      })

      this.setState(stationId, {
        status: 'recording',
        barcode,
        startedAt: startedAt.toISOString(),
        elapsedSeconds: 0,
        lastError: null,
        dbId,
        videoPath,
        activeCameraId: cameraId,
        activeWidth: mode?.width ?? null,
        activeHeight: mode?.height ?? null,
        activeFps: mode?.fps ?? null
      })
      logger.info('Recording started', { stationId, barcode, camera: cameraDisplayName, cameraId, success: true })

      // The warehouse API is only ever notified once a recording actually
      // finishes (see finalizeStoppedRecording's `enqueue('confirm', ...)`)
      // - starting a recording no longer reports anything upstream.
    } catch (err) {
      const message = (err as Error).message
      this.setState(stationId, { status: 'error', lastError: message })
      logger.error('Failed to start recording', { stationId, barcode, error: message })
    }
  }

  private async stopRecording(stationId: string): Promise<void> {
    const state = this.states.get(stationId)
    if (!state) return

    logger.info('Recording stop: requested', { stationId, barcode: state.barcode, videoPath: state.videoPath })

    // The live preview is entirely unaffected by this - it's fed
    // continuously by PersistentCaptureService regardless of recording
    // status. Flip to 'processing' immediately rather than leaving the
    // dashboard showing a frozen elapsed timer for the trim/verify/DB/
    // metadata work still happening below.
    this.setState(stationId, { status: 'processing' })

    if (!state.activeCameraId) {
      // Nothing was actually marked as recording (shouldn't happen via the
      // normal barcode-driven stop path) - defensive, matches the rest of
      // this state machine's style rather than leaving the station stuck.
      this.setState(stationId, {
        status: 'idle',
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    try {
      await this.finalizeStoppedRecording(stationId, state)
    } catch (err) {
      // Anything unexpected here must never leave a station stuck in
      // 'processing' forever - that would mean it can never record again
      // without restarting the app.
      const message = (err as Error).message
      logger.error('Recording stop: unexpected failure during finalize, forcing station back to error state', {
        stationId,
        barcode: state.barcode,
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
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
    }
    this.reconcileCaptureForStation(stationId).catch(() => undefined)
  }

  private async finalizeStoppedRecording(stationId: string, state: StationRuntime): Promise<void> {
    const station = this.getStationConfig(stationId)
    const cameraId = state.activeCameraId!

    if (!state.videoPath) {
      const message = 'ไม่พบตำแหน่งไฟล์วิดีโอสำหรับการบันทึกนี้'
      if (state.dbId) database.markError(state.dbId, message)
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: no videoPath recorded for this session', { stationId, barcode: state.barcode })
      this.setState(stationId, {
        status: 'error',
        lastError: message,
        barcode: null,
        startedAt: null,
        elapsedSeconds: 0,
        dbId: null,
        videoPath: null,
        activeCameraId: null,
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    // Trims and concatenates the segments this recording spans, straight
    // into the final videoPath via stream copy - no separate capture.mp4/
    // rename step and no re-encode, since the segments already contain the
    // final-quality H.264 (see PersistentCaptureService).
    const finalizeResult = await persistentCaptureService.finalizeRecording(cameraId, state.videoPath)

    if (!finalizeResult.success) {
      const message = finalizeResult.error ?? 'การบันทึกวิดีโอล้มเหลว'
      if (state.dbId) database.markError(state.dbId, message)
      this.writeMetadataFor(stationId, state)
      logger.error('Recording stop: failed to finalize captured segments', {
        stationId,
        barcode: state.barcode,
        error: finalizeResult.error
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
        activeWidth: null,
        activeHeight: null,
        activeFps: null
      })
      return
    }

    // The file on disk isn't trustworthy just because the trim/concat
    // exited 0 - only actually decoding it proves it's playable. Passing
    // the negotiated width/height/fps lets verifyRecording cross-check what
    // was actually written against what this capture was running at.
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
      actualResolution:
        verification.actualWidth !== null && verification.actualHeight !== null
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
      activeWidth: null,
      activeHeight: null,
      activeFps: null
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
    persistentCaptureService.killAll()
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
