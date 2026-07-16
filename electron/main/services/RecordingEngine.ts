import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { QUALITY_PRESETS, type StationConfig, type OverlayConfig } from '@shared/types'

const SYSTEM_FONT_FILE = 'C:/Windows/Fonts/arial.ttf'

interface ActiveRecording {
  stationId: string
  process: ChildProcessWithoutNullStreams
  outputPath: string
  stoppedByUs: boolean
  stopResolvers: Array<() => void>
}

interface StartResult {
  outputDir: string
  videoPath: string
  resolutionLabel: string
}

/** Owns one ffmpeg child process per packing station. Each station is fully
 *  independent - starting/stopping one never touches another's process. */
class RecordingEngine extends EventEmitter {
  private active = new Map<string, ActiveRecording>()

  isRecording(stationId: string): boolean {
    return this.active.has(stationId)
  }

  async start(
    station: StationConfig,
    cameraDeviceId: string,
    barcode: string,
    saveLocation: string,
    overlay: { config: OverlayConfig; textFilePath: string } | null
  ): Promise<StartResult> {
    if (this.active.has(station.id)) {
      throw new Error(`Station "${station.name}" is already recording`)
    }

    const outputDir = path.join(saveLocation, barcode)
    fs.mkdirSync(outputDir, { recursive: true })
    const videoPath = path.join(outputDir, 'packing.mp4')

    const preset = QUALITY_PRESETS[station.qualityPreset]
    const ffmpegPath = resolveFfmpegPath()
    const args = buildRecordArgs({
      cameraDeviceId,
      micName: station.micName,
      width: preset.width,
      height: preset.height,
      fps: station.fps,
      bitrateKbps: station.bitrateKbps,
      outputPath: videoPath,
      overlay
    })

    logger.info('Recording start: launching ffmpeg', {
      station: station.name,
      barcode,
      videoPath,
      ffmpegPath,
      commandLine: `${ffmpegPath} ${args.join(' ')}`
    })

    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const record: ActiveRecording = {
      stationId: station.id,
      process: child,
      outputPath: videoPath,
      stoppedByUs: false,
      stopResolvers: []
    }
    this.active.set(station.id, record)

    // Kept in full (not just a tail) for this recording's lifetime and
    // logged in full on every exit path - "warning" loglevel is quiet in the
    // common case but must never be silently discarded, since a warning here
    // (e.g. dropped frames, a muxer complaint) is exactly the kind of signal
    // that explains a file that turns out unplayable despite ffmpeg exiting
    // with code 0.
    let stderrLog = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLog += chunk.toString()
    })

    child.on('exit', (code, signal) => {
      this.active.delete(station.id)
      record.stopResolvers.forEach((resolve) => resolve())
      if (!record.stoppedByUs) {
        logger.error('ffmpeg exited unexpectedly during recording', {
          station: station.name,
          barcode,
          videoPath,
          code,
          signal,
          stderr: stderrLog.slice(-4000)
        })
        this.emit('unexpectedExit', { stationId: station.id, barcode, message: summarizeFfmpegError(stderrLog) })
      } else {
        logger.info('Recording stop: ffmpeg process exited', {
          station: station.name,
          barcode,
          videoPath,
          code,
          signal,
          forcedKill: signal === 'SIGKILL',
          stderr: stderrLog.trim() ? stderrLog.slice(-4000) : '(empty)'
        })
      }
    })

    child.on('error', (err) => {
      logger.error('ffmpeg failed to start', { station: station.name, error: err.message })
      this.active.delete(station.id)
      this.emit('unexpectedExit', { stationId: station.id, barcode, message: err.message })
    })

    return { outputDir, videoPath, resolutionLabel: preset.label }
  }

  /** Gracefully stops ffmpeg by writing 'q' to stdin, which tells it to finish
   *  the current frame and finalize the mp4's moov atom instead of leaving a
   *  corrupt/unplayable file behind. Falls back to SIGKILL if it hangs. */
  async stop(stationId: string): Promise<void> {
    const record = this.active.get(stationId)
    if (!record) return

    record.stoppedByUs = true

    const exited = new Promise<void>((resolve) => {
      record.stopResolvers.push(resolve)
    })

    try {
      record.process.stdin.write('q')
    } catch {
      // stdin may already be closed if ffmpeg crashed; force-kill below handles it.
    }

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10000))
    await Promise.race([exited, timeout])

    if (this.active.has(stationId)) {
      logger.warn('ffmpeg did not exit gracefully in time, force killing', { stationId })
      record.process.kill('SIGKILL')
      await exited
    }
  }

  /** Force-kills without waiting - used on app quit so we never hang shutdown. */
  killAll(): void {
    for (const record of this.active.values()) {
      record.stoppedByUs = true
      record.process.kill('SIGKILL')
    }
    this.active.clear()
  }

  /** Diagnostics-only: opens one specific camera by its unique device id and
   *  records a few real seconds to a throwaway temp file, proving ffmpeg can
   *  actually acquire that exact physical device (not just that it appears
   *  in a device list) without conflicting with any other camera. Entirely
   *  isolated from `active`/`start`/`stop` - it never touches the station
   *  recording workflow, so two of these (or one of these plus a real
   *  station recording) can safely run concurrently against two different
   *  device ids at once, which is exactly what needs verifying for two
   *  identical webcams. */
  async testRecording(
    cameraDeviceId: string,
    micName: string | null,
    durationSeconds = 2
  ): Promise<{ success: boolean; error: string | null; ffmpegCommand: string }> {
    const ffmpegPath = resolveFfmpegPath()
    const tempPath = path.join(os.tmpdir(), `packing-recorder-diagnostic-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`)
    const deviceSpec = micName ? `video=${cameraDeviceId}:audio=${micName}` : `video=${cameraDeviceId}`
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-f',
      'dshow',
      // Deliberately no -video_size/-framerate here: forcing a specific mode
      // (640x480@15 was tried first) fails outright on hardware that doesn't
      // offer that exact combination - confirmed by reproducing the same
      // "Could not find video device" / I/O error against real hardware,
      // then getting a clean recording once the resolution/framerate
      // constraints were dropped and DirectShow was left to pick the
      // device's own default mode. A diagnostic test only needs to prove the
      // device opens and produces frames, not any particular mode.
      '-rtbufsize',
      '128M',
      '-i',
      deviceSpec,
      '-t',
      String(durationSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-y',
      tempPath
    ]

    const ffmpegCommand = `${ffmpegPath} ${args.join(' ')}`
    logger.info('Diagnostic test recording starting', { cameraDeviceId, args: args.join(' ') })

    return new Promise((resolve) => {
      let stderrTail = ''
      const child = spawn(ffmpegPath, args)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000)
      })
      child.on('error', (err) => {
        logger.error('Diagnostic test recording failed to start', { cameraDeviceId, error: err.message })
        resolve({ success: false, error: err.message, ffmpegCommand })
      })
      child.on('close', (code) => {
        let success = false
        try {
          success = code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0
        } catch {
          success = false
        }
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
        } catch {
          // best-effort cleanup of a throwaway diagnostic file
        }
        if (success) {
          logger.info('Diagnostic test recording succeeded', { cameraDeviceId })
          resolve({ success: true, error: null, ffmpegCommand })
        } else {
          const message = summarizeFfmpegError(stderrTail)
          logger.warn('Diagnostic test recording failed', { cameraDeviceId, code, error: message })
          resolve({ success: false, error: message, ffmpegCommand })
        }
      })
    })
  }

  /** Extracts one frame at ~1s in as thumbnail.jpg. A recording shorter than
   *  that (e.g. a barcode scanned and immediately scanned again to stop) has
   *  no frame at 00:00:01, so that attempt produces nothing usable - falls
   *  back to grabbing the very first frame instead, so a short recording
   *  still gets a real thumbnail rather than a broken image in the History
   *  page. Either attempt must produce a non-empty file to count as success -
   *  a nonzero exit code alone isn't a reliable enough signal (seen in
   *  practice: ffmpeg can exit 0 while writing a 0-byte file when the seek
   *  target is past the last frame). */
  async generateThumbnail(videoPath: string): Promise<string | null> {
    const thumbnailPath = path.join(path.dirname(videoPath), 'thumbnail.jpg')
    const extractedAtOneSecond = await this.extractFrame(videoPath, thumbnailPath, '00:00:01')
    if (extractedAtOneSecond) return thumbnailPath

    logger.warn('Thumbnail at 1s produced nothing, retrying from the first frame', { videoPath })
    const extractedAtStart = await this.extractFrame(videoPath, thumbnailPath, null)
    return extractedAtStart ? thumbnailPath : null
  }

  private extractFrame(videoPath: string, outputPath: string, seekTo: string | null): Promise<boolean> {
    const ffmpegPath = resolveFfmpegPath()
    const args = ['-y', ...(seekTo ? ['-ss', seekTo] : []), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outputPath]
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, args)
      child.on('exit', (code) => {
        let success = false
        try {
          success = code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0
        } catch {
          success = false
        }
        if (!success) logger.warn('Thumbnail frame extraction failed', { videoPath, seekTo, code })
        resolve(success)
      })
      child.on('error', (err) => {
        logger.warn('Thumbnail frame extraction errored', { videoPath, seekTo, error: err.message })
        resolve(false)
      })
    })
  }

  /** Fully decodes the recorded file (output discarded, errors surfaced) to
   *  confirm it's actually playable - not just present with a nonzero size.
   *  A file force-killed mid-finalization (see stop()'s SIGKILL fallback)
   *  can still exist on disk with real bytes in it despite having no moov
   *  atom, which every player refuses to open - file size alone can't catch
   *  that, only actually trying to decode it can. Reuses the already-bundled
   *  ffmpeg.exe rather than adding an ffprobe dependency. */
  async verifyRecording(videoPath: string): Promise<{
    valid: boolean
    error: string | null
    sizeBytes: number
    durationSeconds: number | null
  }> {
    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(videoPath).size
    } catch {
      return { valid: false, error: 'ไม่พบไฟล์วิดีโอที่บันทึกไว้', sizeBytes: 0, durationSeconds: null }
    }
    if (sizeBytes === 0) {
      return { valid: false, error: 'ไฟล์วิดีโอมีขนาด 0 ไบต์', sizeBytes: 0, durationSeconds: null }
    }

    const ffmpegPath = resolveFfmpegPath()
    const args = ['-hide_banner', '-i', videoPath, '-f', 'null', '-']
    logger.info('File finalization: verifying recording is decodable', { videoPath, sizeBytes, commandLine: `${ffmpegPath} ${args.join(' ')}` })

    return new Promise((resolve) => {
      let stderr = ''
      const child = spawn(ffmpegPath, args)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('exit', (code) => {
        const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
        const durationSeconds = durationMatch
          ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
          : null
        const fatalMarkers = ['moov atom not found', 'Invalid data found when processing input', 'could not find codec parameters']
        const hasFatalError = fatalMarkers.some((marker) => stderr.toLowerCase().includes(marker.toLowerCase()))
        const valid = code === 0 && !hasFatalError

        logger.info('File finalization: verification result', {
          videoPath,
          valid,
          exitCode: code,
          sizeBytes,
          durationSeconds,
          stderr: stderr.trim() ? stderr.slice(-2000) : '(empty)'
        })

        resolve({
          valid,
          error: valid ? null : 'ไฟล์วิดีโอเสียหายหรือไม่สามารถเล่นได้ (ffmpeg ไม่สามารถถอดรหัสไฟล์ได้สำเร็จ)',
          sizeBytes,
          durationSeconds
        })
      })
      child.on('error', (err) => {
        logger.warn('File finalization: verification process failed to start', { videoPath, error: err.message })
        resolve({ valid: false, error: err.message, sizeBytes, durationSeconds: null })
      })
    })
  }
}

function buildRecordArgs(input: {
  /** Either the DirectShow "Alternative name" device path (unambiguous even
   *  when two cameras share a friendly name) or, for a driver that doesn't
   *  report one, the friendly name itself - see CameraManager. ffmpeg's
   *  dshow input accepts both forms identically as `video=<value>`. */
  cameraDeviceId: string
  micName: string | null
  width: number
  height: number
  fps: number
  bitrateKbps: number
  outputPath: string
  overlay: { config: OverlayConfig; textFilePath: string } | null
}): string[] {
  const deviceSpec = input.micName
    ? `video=${input.cameraDeviceId}:audio=${input.micName}`
    : `video=${input.cameraDeviceId}`

  // Single input, single output - a second ("live preview during recording")
  // output branch was tried here and reverted: it risked the image2 preview
  // muxer's frequent open/overwrite/close cycle stalling or erroring
  // (observed contention with the renderer concurrently reading the same
  // file), which can hang ffmpeg on the graceful 'q' shutdown long enough to
  // hit the 10s SIGKILL fallback in stop() - killing ffmpeg mid-finalization
  // is exactly what produces a recording with no moov atom, i.e. a saved but
  // unplayable file. One input/one output keeps the actual recording's
  // finalization dependent on nothing but itself.
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-f',
    'dshow',
    '-video_size',
    `${input.width}x${input.height}`,
    '-framerate',
    String(input.fps),
    '-rtbufsize',
    '512M',
    '-i',
    deviceSpec
  ]

  if (input.overlay?.config.enabled) {
    args.push('-vf', buildOverlayFilter(input.overlay.config, input.overlay.textFilePath))
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', `${input.bitrateKbps}k`)

  if (input.micName) {
    args.push('-c:a', 'aac', '-b:a', '128k')
  } else {
    args.push('-an')
  }

  args.push('-movflags', '+faststart', '-y', input.outputPath)
  return args
}

/** ffmpeg's filtergraph value parser goes through two rounds of unescaping,
 *  so a literal colon (as in a Windows drive letter) needs to survive both -
 *  a single backslash is not enough and silently produces a "both text and
 *  text file provided" parse error. Forward slashes avoid needing to escape
 *  path separators at all. */
function escapeFfmpegPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\\\:')
}

function overlayPositionExpr(position: OverlayConfig['position']): { x: string; y: string } {
  const margin = 20
  switch (position) {
    case 'top-left':
      return { x: `${margin}`, y: `${margin}` }
    case 'top-right':
      return { x: `w-text_w-${margin}`, y: `${margin}` }
    case 'bottom-left':
      return { x: `${margin}`, y: `h-text_h-${margin}` }
    case 'bottom-right':
      return { x: `w-text_w-${margin}`, y: `h-text_h-${margin}` }
  }
}

function buildOverlayFilter(config: OverlayConfig, textFilePath: string): string {
  const { x, y } = overlayPositionExpr(config.position)
  const fontColorHex = config.fontColor.replace('#', '')
  const bgColorHex = config.backgroundColor.replace('#', '')
  const bgOpacity = (Math.max(0, Math.min(100, config.backgroundOpacity)) / 100).toFixed(2)
  const lineSpacing = Math.max(2, Math.round(config.fontSize * 0.3))

  return [
    `drawtext=fontfile=${escapeFfmpegPath(SYSTEM_FONT_FILE)}`,
    `textfile=${escapeFfmpegPath(textFilePath)}`,
    'reload=1',
    `x=${x}`,
    `y=${y}`,
    `fontsize=${config.fontSize}`,
    `fontcolor=0x${fontColorHex}`,
    'box=1',
    `boxcolor=0x${bgColorHex}@${bgOpacity}`,
    'boxborderw=8',
    `line_spacing=${lineSpacing}`
  ].join(':')
}

function summarizeFfmpegError(stderrTail: string): string {
  if (stderrTail.includes('Could not run graph')) return 'Camera is unavailable or already in use'
  if (stderrTail.toLowerCase().includes('no such file or directory')) return 'Camera device not found (disconnected?)'
  if (stderrTail.toLowerCase().includes('permission denied')) return 'Camera access denied'
  const lastLine = stderrTail.trim().split(/\r?\n/).pop()
  return lastLine || 'Unknown ffmpeg error'
}

export const recordingEngine = new RecordingEngine()
