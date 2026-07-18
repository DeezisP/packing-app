import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { recordingEngine, summarizeFfmpegError, isEncoderInitError, ENCODER_PRIORITY } from './RecordingEngine'
import type { HardwareEncoder } from './RecordingEngine'
import { buildOverlayLines, formatDateLocal, formatTimeLocal, formatHms } from '@shared/types'
import type { OverlayConfig } from '@shared/types'

const GRACEFUL_STOP_TIMEOUT_MS = 8000
const OVERLAY_UPDATE_INTERVAL_MS = 1000
const OPEN_DEVICE_RETRY_ATTEMPTS = 3
const OPEN_DEVICE_RETRY_DELAY_MS = 700
/** How long to wait, after spawning, before assuming a live dshow capture
 *  actually opened the device successfully - confirmed empirically that a
 *  real "device busy"/"could not run graph" failure surfaces on stderr
 *  within a few hundred ms, so this only matters as a ceiling for a slow
 *  driver init; the common case resolves much sooner via the `frame=`
 *  progress-stats check below. */
const DEVICE_OPEN_GRACE_MS = 3000

const MARGIN = 20
const BOX_PADDING = 8

const WINDOWS_ARIAL_PATH = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf')

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface OverlayParams {
  config: OverlayConfig
  staticData: { barcode: string; station: string; camera: string }
}

export interface StartRecordingParams {
  sessionId: string
  stationId: string
  cameraId: string
  micName: string | null
  width: number
  height: number
  fps: number
  bitrateKbps: number
  overlay: OverlayParams | null
  startedAt: string
  outputDir: string
}

interface ActiveSession {
  stationId: string
  child: ChildProcess
  overlayTextPath: string | null
  overlayTimer: NodeJS.Timeout | null
  stderrTail: string
  stopResolvers: Array<(result: { success: boolean; error: string | null }) => void>
  killTimer: NodeJS.Timeout | null
}

/** ffmpeg filter-graph option values (fontfile=, textfile=) need their own
 *  escaping, independent of shell quoting - `spawn()` passes args as an
 *  array with no shell involved, so this is purely about ffmpeg's own
 *  filter-string parser. Forward slashes sidestep backslash-escaping
 *  entirely (Windows accepts them in paths), and the drive-letter colon is
 *  the one remaining character the filter parser treats as special. */
function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

function toFfmpegColor(hex: string, opacityPercent?: number): string {
  const clean = hex.replace('#', '').toLowerCase()
  return opacityPercent === undefined ? `0x${clean}` : `0x${clean}@${(opacityPercent / 100).toFixed(2)}`
}

/** Builds the one drawtext filter that burns the overlay into the live
 *  encode - ffmpeg's own equivalent of the old canvas-compositing step (see
 *  canvasOverlay.ts, now deleted). `textfile=...:reload=1` re-reads the file
 *  from disk on every frame, which is what makes the date/time/timer fields
 *  update live; LiveRecordingService rewrites that file once a second (see
 *  writeOverlayTextFile) rather than needing ffmpeg to know anything about
 *  clocks itself. `box=1` draws a single rectangle behind the whole
 *  multi-line block, matching the canvas version's one-box-behind-all-lines
 *  layout; the x/y expressions position that box the same MARGIN from the
 *  edge with the same BOX_PADDING inset that canvasOverlay.ts used, using
 *  drawtext's built-in text_w/text_h (the rendered text block's own size) so
 *  right/bottom-aligned positions correctly account for content length. */
function buildDrawtextFilter(config: OverlayConfig, overlayTextPath: string, fontFilePath: string | null): string {
  const boxColor = toFfmpegColor(config.backgroundColor, config.backgroundOpacity)
  const fontColor = toFfmpegColor(config.fontColor)
  const lineSpacing = Math.max(2, Math.round(config.fontSize * 0.3))
  const textFile = escapeFfmpegFilterPath(overlayTextPath)
  const inset = MARGIN + BOX_PADDING

  let x: string
  let y: string
  switch (config.position) {
    case 'top-left':
      x = String(inset)
      y = String(inset)
      break
    case 'top-right':
      x = `w-text_w-${inset}`
      y = String(inset)
      break
    case 'bottom-left':
      x = String(inset)
      y = `h-text_h-${inset}`
      break
    case 'bottom-right':
      x = `w-text_w-${inset}`
      y = `h-text_h-${inset}`
      break
  }

  const fontPart = fontFilePath ? `fontfile='${escapeFfmpegFilterPath(fontFilePath)}':` : 'font=Arial:'
  return (
    `drawtext=${fontPart}textfile='${textFile}':reload=1:` +
    `x=${x}:y=${y}:fontsize=${config.fontSize}:fontcolor=${fontColor}:` +
    `box=1:boxcolor=${boxColor}:boxborderw=${BOX_PADDING}:line_spacing=${lineSpacing}`
  )
}

function writeOverlayTextFile(filePath: string, overlay: OverlayParams, startedAtIso: string): void {
  const startedAtMs = new Date(startedAtIso).getTime()
  const now = new Date()
  const lines = buildOverlayLines(overlay.config, {
    barcode: overlay.staticData.barcode,
    date: formatDateLocal(now),
    time: formatTimeLocal(now),
    timer: formatHms(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))),
    station: overlay.staticData.station,
    camera: overlay.staticData.camera
  })
  try {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
  } catch (err) {
    logger.warn('Live recording: failed to update overlay text file', { filePath, error: (err as Error).message })
  }
}

function buildEncoderArgs(encoder: HardwareEncoder, bitrateKbps: number): string[] {
  const bitrate = `${bitrateKbps}k`
  const bufsize = `${bitrateKbps * 2}k`
  switch (encoder) {
    case 'h264_nvenc':
      // p4/ll/cbr: NVENC's mid-speed preset with the low-latency tune and a
      // constant-bitrate rate control, chosen for live capture rather than
      // offline quality - verified against this exact ffmpeg build with a
      // real 1080p60 encode before shipping this.
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cbr', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize]
    case 'libx264':
      // Software fallback only reached when no GPU encoder is usable -
      // ultrafast + zerolatency prioritizes sustaining real-time fps over
      // compression efficiency, per the explicit "fast preset suitable for
      // live recording" requirement.
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize]
  }
}

/** Owns every live ffmpeg recording process - the direct replacement for the
 *  old renderer-side MediaRecorder pipeline (useRecordingCapture.ts, now
 *  deleted) and the main-process CaptureIngestService that used to relay its
 *  chunks (also deleted). ffmpeg now opens the physical camera itself via
 *  DirectShow and hardware-encodes straight to a single MP4 file - no
 *  browser encode, no intermediate webm, no separate transcode pass.
 *
 *  This UVC camera hardware does not support two simultaneous opens
 *  (confirmed against real hardware), so StationManager must have the
 *  renderer's own getUserMedia preview release the device (see
 *  CameraPreviewReleaseRequest) before calling startRecording, and only
 *  tell the renderer to resume its preview after stopRecording's promise
 *  resolves - this service has no visibility into the renderer's preview
 *  state at all, that handshake lives entirely in StationManager. */
class LiveRecordingService extends EventEmitter {
  private sessions = new Map<string, ActiveSession>()

  async startRecording(
    params: StartRecordingParams
  ): Promise<{ success: boolean; error: string | null; capturePath: string; encoder: HardwareEncoder | null }> {
    const capturePath = path.join(params.outputDir, 'capture.mp4')
    let encoder = await recordingEngine.detectEncoder()

    let overlayTextPath: string | null = null
    let vf: string | null = null
    if (params.overlay) {
      overlayTextPath = path.join(params.outputDir, 'overlay.txt')
      const fontFilePath = fs.existsSync(WINDOWS_ARIAL_PATH) ? WINDOWS_ARIAL_PATH : null
      writeOverlayTextFile(overlayTextPath, params.overlay, params.startedAt)
      vf = buildDrawtextFilter(params.overlay.config, overlayTextPath, fontFilePath)
    }

    const deviceSpec = params.micName ? `video=${params.cameraId}:audio=${params.micName}` : `video=${params.cameraId}`
    const buildArgs = (enc: HardwareEncoder): string[] => [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-stats',
      '-f',
      'dshow',
      '-rtbufsize',
      '512M',
      '-video_size',
      `${params.width}x${params.height}`,
      '-framerate',
      String(params.fps),
      '-i',
      deviceSpec,
      ...(vf ? ['-vf', vf] : []),
      ...buildEncoderArgs(enc, params.bitrateKbps),
      '-pix_fmt',
      'yuv420p',
      ...(params.micName ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags',
      '+faststart',
      '-y',
      capturePath
    ]

    let lastError = 'Unknown ffmpeg error'

    // Outer loop: fall back to the next encoder in priority order when a
    // failure looks encoder-shaped (see isEncoderInitError) - the one-time
    // startup probe (RecordingEngine.detectEncoder) uses bare/minimal flags,
    // so a different driver state or GPU generation can still fail here
    // even after passing that probe. Bounded by the number of known
    // encoders and always reaches libx264 (pure software, nothing hardware
    // to fail on) in the worst case, so this always terminates. Inner loop:
    // retry the *same* command a few times for a device-shaped failure
    // (camera transiently busy) - swapping encoders would never fix that.
    for (let encoderAttempt = 0; encoderAttempt < ENCODER_PRIORITY.length; encoderAttempt++) {
      const args = buildArgs(encoder)
      let encoderFailureSeen = false

      for (let deviceAttempt = 1; deviceAttempt <= OPEN_DEVICE_RETRY_ATTEMPTS; deviceAttempt++) {
        logger.info('Live recording: starting ffmpeg', {
          sessionId: params.sessionId,
          stationId: params.stationId,
          deviceAttempt,
          encoder,
          commandLine: `${resolveFfmpegPath()} ${args.join(' ')}`
        })

        // eslint-disable-next-line no-await-in-loop
        const result = await this.trySpawn(params.sessionId, params.stationId, args)
        if (result.success) {
          const session = this.sessions.get(params.sessionId)
          if (session && overlayTextPath && params.overlay) {
            const textPath = overlayTextPath
            const overlay = params.overlay
            session.overlayTextPath = textPath
            session.overlayTimer = setInterval(
              () => writeOverlayTextFile(textPath, overlay, params.startedAt),
              OVERLAY_UPDATE_INTERVAL_MS
            )
          }
          return { success: true, error: null, capturePath, encoder }
        }

        lastError = result.error
        if (result.isEncoderIssue) {
          encoderFailureSeen = true
          break
        }

        logger.warn('Live recording: ffmpeg failed to open the camera, retrying', {
          sessionId: params.sessionId,
          stationId: params.stationId,
          deviceAttempt,
          error: lastError
        })
        if (deviceAttempt < OPEN_DEVICE_RETRY_ATTEMPTS) {
          // eslint-disable-next-line no-await-in-loop
          await delay(OPEN_DEVICE_RETRY_DELAY_MS)
        }
      }

      if (!encoderFailureSeen || encoder === 'libx264') break

      const next = recordingEngine.demoteEncoder(encoder)
      logger.warn('Live recording: encoder failed to start a real recording, falling back', {
        sessionId: params.sessionId,
        stationId: params.stationId,
        from: encoder,
        to: next,
        error: lastError
      })
      encoder = next
    }

    if (overlayTextPath) fs.unlink(overlayTextPath, () => undefined)
    return { success: false, error: lastError, capturePath, encoder: null }
  }

  private trySpawn(
    sessionId: string,
    stationId: string,
    args: string[]
  ): Promise<{ success: true } | { success: false; error: string; isEncoderIssue: boolean }> {
    return new Promise((resolve) => {
      const ffmpegPath = resolveFfmpegPath()
      const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })

      const session: ActiveSession = {
        stationId,
        child,
        overlayTextPath: null,
        overlayTimer: null,
        stderrTail: '',
        stopResolvers: [],
        killTimer: null
      }

      let settled = false
      const settleSuccess = (): void => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        this.sessions.set(sessionId, session)
        resolve({ success: true })
      }
      // Classified against the *full* accumulated stderr, not the
      // already-summarized one-liner - summarizeFfmpegError often reduces a
      // multi-line encoder failure down to a generic trailing line like
      // "Nothing was written into output file", which loses the actual
      // "InitializeEncoder failed"/"mfx session"/etc marker isEncoderInitError
      // looks for. `error` (the summary) is still what gets shown to the
      // operator; `isEncoderIssue` is purely for startRecording's fallback
      // decision.
      const settleFailure = (error: string, stderrTail: string): void => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        resolve({ success: false, error, isEncoderIssue: isEncoderInitError(stderrTail) })
      }

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        session.stderrTail = (session.stderrTail + text).slice(-4000)
        if (!settled && /frame=\s*\d+/.test(text)) settleSuccess()
      })
      child.on('error', (err) => settleFailure(err.message, err.message))
      child.on('close', (code) => {
        if (!settled) {
          settleFailure(summarizeFfmpegError(session.stderrTail), session.stderrTail)
          return
        }
        this.handleSessionExit(sessionId, code)
      })

      const graceTimer = setTimeout(settleSuccess, DEVICE_OPEN_GRACE_MS)
    })
  }

  private handleSessionExit(sessionId: string, code: number | null): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    if (session.overlayTimer) clearInterval(session.overlayTimer)
    if (session.killTimer) clearTimeout(session.killTimer)
    if (session.overlayTextPath) fs.unlink(session.overlayTextPath, () => undefined)

    if (session.stopResolvers.length > 0) {
      // A stop was actually requested - resolve with the process's real
      // outcome rather than assuming success just because it was asked to
      // stop, so a stop that happens to coincide with a genuine ffmpeg
      // failure still surfaces as one. verifyRecording (StationManager) is
      // the final authority on the output file either way.
      const success = code === 0
      const error = success ? null : summarizeFfmpegError(session.stderrTail)
      session.stopResolvers.forEach((resolve) => resolve({ success, error }))
      return
    }

    // Nobody asked this to stop - the device was unplugged, the driver
    // crashed, or ffmpeg died some other way mid-recording. Mirrors the old
    // renderer-crash-report shape (sessionId/stationId/message) so
    // StationManager's existing error handling doesn't need a second shape
    // to react to.
    const message = summarizeFfmpegError(session.stderrTail)
    logger.error('Live recording: ffmpeg exited unexpectedly during an active recording', {
      sessionId,
      stationId: session.stationId,
      code,
      error: message
    })
    this.emit('captureError', { sessionId, stationId: session.stationId, message })
  }

  /** Sends ffmpeg's interactive graceful-stop keypress ('q' on stdin, the
   *  standard way to stop a live ffmpeg capture cleanly on Windows where
   *  POSIX signals aren't deliverable) and waits for it to actually exit and
   *  finish writing the mp4's trailer/moov atom. Force-kills only after
   *  `timeoutMs` with no exit - generous by default because killing an mp4
   *  muxer mid-write is exactly how the v1.6.2 incident produced an
   *  unplayable "moov atom not found" file; StationManager's
   *  verifyRecording step is the last line of defense if this ever has to
   *  fall through to a force-kill anyway. */
  async stopRecording(
    sessionId: string,
    timeoutMs = GRACEFUL_STOP_TIMEOUT_MS
  ): Promise<{ success: boolean; error: string | null }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { success: false, error: 'No active recording session' }
    }

    if (session.overlayTimer) {
      clearInterval(session.overlayTimer)
      session.overlayTimer = null
    }

    const result = new Promise<{ success: boolean; error: string | null }>((resolve) => {
      session.stopResolvers.push(resolve)
    })

    try {
      session.child.stdin?.write('q')
    } catch (err) {
      logger.warn('Live recording: failed to write graceful-stop key, will rely on the force-kill timeout', {
        sessionId,
        error: (err as Error).message
      })
    }

    session.killTimer = setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        logger.warn('Live recording: graceful stop timed out, force-killing ffmpeg', { sessionId, timeoutMs })
        session.child.kill()
      }
    }, timeoutMs)

    return result
  }

  /** Force-closes every in-flight recording without waiting - used on app
   *  quit so shutdown never hangs. Mirrors the old CaptureIngestService's
   *  killAll semantics exactly: best-effort, not graceful, because the app
   *  is already going away regardless. */
  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.overlayTimer) clearInterval(session.overlayTimer)
      if (session.killTimer) clearTimeout(session.killTimer)
      if (session.overlayTextPath) {
        try {
          fs.unlinkSync(session.overlayTextPath)
        } catch {
          // best-effort
        }
      }
      try {
        session.child.kill()
      } catch {
        // best-effort
      }
    }
    this.sessions.clear()
  }
}

export const liveRecordingService = new LiveRecordingService()
