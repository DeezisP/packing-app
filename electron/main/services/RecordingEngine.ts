import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { RESOLUTION_PRESETS, type StationConfig, type OverlayConfig } from '@shared/types'

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

    const resolution = RESOLUTION_PRESETS[station.resolutionPreset]
    const ffmpegPath = resolveFfmpegPath()
    const args = buildRecordArgs({
      cameraDeviceId,
      micName: station.micName,
      width: resolution.width,
      height: resolution.height,
      fps: station.fps,
      bitrateKbps: station.bitrateKbps,
      outputPath: videoPath,
      overlay
    })

    logger.info('Starting ffmpeg recording', { station: station.name, barcode, args: args.join(' ') })

    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const record: ActiveRecording = {
      stationId: station.id,
      process: child,
      outputPath: videoPath,
      stoppedByUs: false,
      stopResolvers: []
    }
    this.active.set(station.id, record)

    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000)
    })

    child.on('exit', (code, signal) => {
      this.active.delete(station.id)
      record.stopResolvers.forEach((resolve) => resolve())
      if (!record.stoppedByUs) {
        logger.error('ffmpeg exited unexpectedly during recording', {
          station: station.name,
          barcode,
          code,
          signal,
          stderrTail
        })
        this.emit('unexpectedExit', { stationId: station.id, barcode, message: summarizeFfmpegError(stderrTail) })
      } else {
        logger.info('ffmpeg recording stopped', { station: station.name, barcode, code, signal })
      }
    })

    child.on('error', (err) => {
      logger.error('ffmpeg failed to start', { station: station.name, error: err.message })
      this.active.delete(station.id)
      this.emit('unexpectedExit', { stationId: station.id, barcode, message: err.message })
    })

    return { outputDir, videoPath, resolutionLabel: station.resolutionPreset }
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

  async generateThumbnail(videoPath: string): Promise<string | null> {
    const thumbnailPath = path.join(path.dirname(videoPath), 'thumbnail.jpg')
    const ffmpegPath = resolveFfmpegPath()
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, [
        '-y',
        '-ss',
        '00:00:01',
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        thumbnailPath
      ])
      child.on('exit', (code) => {
        if (code === 0 && fs.existsSync(thumbnailPath)) {
          resolve(thumbnailPath)
        } else {
          logger.warn('Thumbnail generation failed', { videoPath, code })
          resolve(null)
        }
      })
      child.on('error', (err) => {
        logger.warn('Thumbnail generation errored', { videoPath, error: err.message })
        resolve(null)
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

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${input.bitrateKbps}k`
  )

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
