import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'

/** The four H.264 encoders this app knows how to drive, in the priority order
 *  a machine should try them: GPU vendor-specific hardware encoders first
 *  (fastest, lowest CPU usage, and the only way to sustain 4K30/1080p60 in
 *  real time on modest hardware), falling back to the universally-available
 *  CPU encoder only when no hardware path exists. */
export type HardwareEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'

export const ENCODER_PRIORITY: HardwareEncoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']

/** The encoder immediately after `current` in priority order, falling all
 *  the way back to `libx264` (never undefined) - libx264 is pure software
 *  with no driver/hardware dependency, so it's always reachable regardless
 *  of what GPU (if any) is present. */
function getNextEncoder(current: HardwareEncoder): HardwareEncoder {
  const index = ENCODER_PRIORITY.indexOf(current)
  return ENCODER_PRIORITY[index + 1] ?? 'libx264'
}

/** File-based ffmpeg utilities used by the recording pipeline, plus hardware
 *  encoder detection shared by the live recording path (see
 *  LiveRecordingService). The file-based methods below (testRecording,
 *  generateThumbnail, verifyRecording) all operate on a static,
 *  already-complete input file (never a live camera device), which is what
 *  makes them safe: there is no exclusive-device contention to race, no live
 *  shutdown timing to get wrong. The live camera capture itself - opening the
 *  device, encoding in real time, and the graceful-shutdown timing that
 *  actually matters - is owned entirely by LiveRecordingService, which is
 *  also where the one ffmpeg process that *does* touch an in-progress
 *  recording lives. */
class RecordingEngine {
  private detectedEncoderPromise: Promise<HardwareEncoder> | null = null

  /** Picks the best H.264 encoder actually usable on this machine, in
   *  priority order (NVENC > Quick Sync > AMF > libx264). "Compiled into
   *  ffmpeg" isn't enough to know an encoder will work - h264_nvenc is
   *  listed by every build of this app's bundled ffmpeg regardless of
   *  whether an NVIDIA GPU is even present, and only fails at the moment it
   *  actually tries to initialize against real hardware/drivers. So each
   *  candidate is probed with a real, tiny encode (large enough - 1280x720 -
   *  to clear NVENC's minimum frame-size floor, which otherwise produces a
   *  misleading failure that looks like "no hardware" but actually means
   *  "test frame too small"). Probed once and cached for the process's
   *  lifetime - hardware doesn't change at runtime. */
  async detectEncoder(): Promise<HardwareEncoder> {
    if (!this.detectedEncoderPromise) {
      this.detectedEncoderPromise = this.probeEncoders()
    }
    return this.detectedEncoderPromise
  }

  /** Moves the cached "best encoder" choice to the next one in priority
   *  order after `failedEncoder`, and returns the new choice. Called by
   *  LiveRecordingService when an encoder that passed the one-time startup
   *  probe above still fails to actually initialize for a real recording -
   *  the probe uses bare/minimal flags, but a real recording adds
   *  encoder-specific tuning (preset/tune/rc) the probe never exercises, so
   *  a different driver state or GPU generation can still fail at that
   *  point even after passing the probe. Persisted for the rest of this
   *  process's lifetime (same as the initial detection) so a later
   *  recording doesn't repeat a choice already known to fail here - resets
   *  naturally on the next app launch in case the underlying cause was
   *  transient (another app briefly holding the only NVENC session slot,
   *  etc). Always reaches libx264 eventually, which has no hardware
   *  dependency to fail on. */
  demoteEncoder(failedEncoder: HardwareEncoder): HardwareEncoder {
    const next = getNextEncoder(failedEncoder)
    this.detectedEncoderPromise = Promise.resolve(next)
    logger.warn('Hardware encoder demoted after failing to actually start a recording', { failed: failedEncoder, next })
    return next
  }

  /** Proactive "is ffmpeg even usable" check, meant to be run once at app
   *  startup so a missing/corrupt bundled binary surfaces as one clear,
   *  early diagnostic instead of only failing the moment someone first
   *  tries to record. Never throws - a missing/unrunnable ffmpeg is a real,
   *  expected possibility on some machine somewhere (corrupted install,
   *  antivirus quarantine, etc.), not a programming error, so this reports
   *  it the same way every other expected failure in this app is reported:
   *  a clear message, logged, station recording simply won't work until
   *  it's fixed - never a crash. */
  async verifyFfmpegAvailable(): Promise<{ available: boolean; path: string | null; version: string | null; error: string | null }> {
    let ffmpegPath: string
    try {
      ffmpegPath = resolveFfmpegPath()
    } catch (err) {
      const message = (err as Error).message
      logger.error('FFmpeg check: bundled binary not found', { error: message })
      return { available: false, path: null, version: null, error: message }
    }

    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, ['-version'])
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.on('error', (err) => {
        logger.error('FFmpeg check: binary present but failed to run', { path: ffmpegPath, error: err.message })
        resolve({ available: false, path: ffmpegPath, version: null, error: err.message })
      })
      child.on('close', (code) => {
        const versionLine = stdout.split(/\r?\n/)[0] ?? null
        if (code === 0 && versionLine) {
          logger.info('FFmpeg check: available', { path: ffmpegPath, version: versionLine })
          resolve({ available: true, path: ffmpegPath, version: versionLine, error: null })
        } else {
          const message = `ffmpeg exited with code ${code} when checking version`
          logger.error('FFmpeg check: binary present but did not run correctly', { path: ffmpegPath, code })
          resolve({ available: false, path: ffmpegPath, version: null, error: message })
        }
      })
    })
  }

  private async probeEncoders(): Promise<HardwareEncoder> {
    for (const encoder of ENCODER_PRIORITY) {
      if (encoder === 'libx264') return encoder
      // eslint-disable-next-line no-await-in-loop
      const works = await this.probeOneEncoder(encoder)
      if (works) {
        logger.info('Hardware encoder detected', { encoder })
        return encoder
      }
      logger.info('Encoder not usable on this machine, trying next', { encoder })
    }
    return 'libx264'
  }

  private probeOneEncoder(encoder: HardwareEncoder): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpegPath = resolveFfmpegPath()
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:s=1280x720:d=0.3',
        '-c:v',
        encoder,
        '-f',
        'null',
        '-'
      ]
      const child = spawn(ffmpegPath, args)
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))
      setTimeout(() => {
        if (!child.killed) child.kill()
        finish(false)
      }, 8000)
    })
  }
  /** Diagnostics-only: opens one specific camera by its unique device id and
   *  records a few real seconds to a throwaway temp file, proving ffmpeg can
   *  actually acquire that exact physical device (not just that it appears
   *  in a device list) without conflicting with any other camera. Safe with
   *  zero coordination: Dashboard and Settings are mutually-exclusive tabs
   *  in the one renderer window, so by the time this can be triggered from
   *  Settings, the Dashboard's own getUserMedia preview for this camera has
   *  already been unmounted and its track stopped - see CameraManager's
   *  class doc comment. */
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
   *  A transcode that exits 0 doesn't guarantee a correct/complete output
   *  any more than a live ffmpeg process exiting 0 used to - only actually
   *  trying to decode it can catch that. Reuses the already-bundled
   *  ffmpeg.exe rather than adding an ffprobe dependency. */
  async verifyRecording(
    videoPath: string,
    expected?: { width: number; height: number; fps: number }
  ): Promise<{
    valid: boolean
    error: string | null
    sizeBytes: number
    durationSeconds: number | null
    actualFps: number | null
    actualWidth: number | null
    actualHeight: number | null
    actualCodec: string | null
  }> {
    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(videoPath).size
    } catch {
      return {
        valid: false,
        error: 'ไม่พบไฟล์วิดีโอที่บันทึกไว้',
        sizeBytes: 0,
        durationSeconds: null,
        actualFps: null,
        actualWidth: null,
        actualHeight: null,
        actualCodec: null
      }
    }
    if (sizeBytes === 0) {
      return {
        valid: false,
        error: 'ไฟล์วิดีโอมีขนาด 0 ไบต์',
        sizeBytes: 0,
        durationSeconds: null,
        actualFps: null,
        actualWidth: null,
        actualHeight: null,
        actualCodec: null
      }
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
        // Everything below is read from the *decoded input stream's own*
        // description - the ground truth for what actually got written to
        // the file, independent of whatever was requested/negotiated before
        // ffmpeg ever opened the camera. Matched against the first "Video:"
        // line only (the input description, which appears before "Stream
        // mapping:") - the `-f null -` output re-states its own fps/
        // resolution too, and those are derived from the input rather than
        // measured, so they're redundant at best here.
        const inputVideoLine = stderr.split('Stream mapping:')[0]
        const fpsMatch = inputVideoLine.match(/Video:.*?(\d+(?:\.\d+)?)\s*fps/)
        const actualFps = fpsMatch ? Number(fpsMatch[1]) : null
        const resolutionMatch = inputVideoLine.match(/Video:.*?(\d{2,5})x(\d{2,5})\b/)
        const actualWidth = resolutionMatch ? Number(resolutionMatch[1]) : null
        const actualHeight = resolutionMatch ? Number(resolutionMatch[2]) : null
        const codecMatch = inputVideoLine.match(/Video:\s*([a-zA-Z0-9_]+)/)
        const actualCodec = codecMatch ? codecMatch[1] : null
        const fatalMarkers = ['moov atom not found', 'Invalid data found when processing input', 'could not find codec parameters']
        const hasFatalError = fatalMarkers.some((marker) => stderr.toLowerCase().includes(marker.toLowerCase()))
        const valid = code === 0 && !hasFatalError

        logger.info('File finalization: verification result', {
          videoPath,
          valid,
          exitCode: code,
          sizeBytes,
          durationSeconds,
          actualFps,
          actualWidth,
          actualHeight,
          actualCodec,
          stderr: stderr.trim() ? stderr.slice(-2000) : '(empty)'
        })

        // Purely diagnostic - a real-world capture's measured fps can land a
        // hair under the requested rate (driver clocking, e.g. 59.94 vs 60)
        // without anything actually being wrong, so this never fails the
        // recording itself. It exists so a *genuine* shortfall (e.g. 60
        // requested, camera/driver silently delivered 30) shows up as a loud,
        // explicit log line instead of only being discoverable by someone
        // manually inspecting the file later.
        if (valid && expected) {
          const mismatches: string[] = []
          if (actualFps !== null && expected.fps - actualFps > 1) {
            mismatches.push(`fps: requested ${expected.fps}, got ${actualFps}`)
          }
          if (actualWidth !== null && actualHeight !== null && (actualWidth !== expected.width || actualHeight !== expected.height)) {
            mismatches.push(`resolution: requested ${expected.width}x${expected.height}, got ${actualWidth}x${actualHeight}`)
          }
          if (mismatches.length > 0) {
            logger.warn('File finalization: recorded mode does not match what was requested/negotiated', {
              videoPath,
              requestedFps: expected.fps,
              requestedResolution: `${expected.width}x${expected.height}`,
              actualFps,
              actualResolution: actualWidth !== null && actualHeight !== null ? `${actualWidth}x${actualHeight}` : null,
              actualCodec,
              mismatches: mismatches.join('; ')
            })
          } else {
            logger.info('File finalization: recorded mode matches requested/negotiated mode', {
              videoPath,
              requestedFps: expected.fps,
              requestedResolution: `${expected.width}x${expected.height}`,
              actualFps,
              actualCodec
            })
          }
        }

        resolve({
          valid,
          error: valid ? null : 'ไฟล์วิดีโอเสียหายหรือไม่สามารถเล่นได้ (ffmpeg ไม่สามารถถอดรหัสไฟล์ได้สำเร็จ)',
          sizeBytes,
          durationSeconds,
          actualFps,
          actualWidth,
          actualHeight,
          actualCodec
        })
      })
      child.on('error', (err) => {
        logger.warn('File finalization: verification process failed to start', { videoPath, error: err.message })
        resolve({
          valid: false,
          error: err.message,
          sizeBytes,
          durationSeconds: null,
          actualFps: null,
          actualWidth: null,
          actualHeight: null,
          actualCodec: null
        })
      })
    })
  }
}

export function summarizeFfmpegError(stderrTail: string): string {
  if (stderrTail.includes('Could not run graph')) return 'Camera is unavailable or already in use'
  if (stderrTail.toLowerCase().includes('no such file or directory')) return 'Camera device not found (disconnected?)'
  if (stderrTail.toLowerCase().includes('permission denied')) return 'Camera access denied'
  const lastLine = stderrTail.trim().split(/\r?\n/).pop()
  return lastLine || 'Unknown ffmpeg error'
}

/** Whether a failed start attempt's stderr looks like the *encoder* was the
 *  problem (driver/GPU/session-limit issue) rather than the camera device -
 *  the signatures ffmpeg actually prints for each hardware encoder's own
 *  init failure, confirmed against this app's own real probing of NVENC,
 *  Quick Sync, and AMF on hardware that didn't support one or more of them.
 *  Used by LiveRecordingService to decide whether a failure should fall
 *  back to the next encoder in priority order (this) or retry the same
 *  command after a short delay (a device-busy/not-found error instead -
 *  see summarizeFfmpegError's own patterns). A false positive here just
 *  means one harmless extra encoder swap before landing on the real cause;
 *  a false negative just means one exhausted retry budget before falling
 *  through - neither can get stuck, since libx264 is always reachable. */
export function isEncoderInitError(stderrTail: string): boolean {
  const lower = stderrTail.toLowerCase()
  const markers = [
    'nvenc',
    'nvencodeapi',
    'cuda',
    'cannot load libnvidia-encode',
    'mfx session',
    'mfx implementation',
    'qsv',
    'amfrt64.dll',
    'amf',
    'unknown encoder',
    'encoder not found',
    'error while opening encoder',
    'initializeencoder failed'
  ]
  return markers.some((m) => lower.includes(m))
}

export const recordingEngine = new RecordingEngine()
