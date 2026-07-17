import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'

/** File-based ffmpeg utilities used by the recording pipeline - all of them
 *  operate on a static, already-complete input file (never a live camera
 *  device), which is what makes them safe: there is no exclusive-device
 *  contention to race, no live shutdown timing to get wrong. The live camera
 *  capture itself is owned entirely by the renderer's getUserMedia/
 *  MediaRecorder pipeline (see useRecordingCapture.ts) and streamed to
 *  CaptureIngestService, which is also where the corresponding webm->mp4
 *  transcode (the one ffmpeg step that still touches an in-progress
 *  recording) lives - kept there rather than here since it's driven by
 *  chunk-arrival/session state that service already owns. */
class RecordingEngine {
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

export function summarizeFfmpegError(stderrTail: string): string {
  if (stderrTail.includes('Could not run graph')) return 'Camera is unavailable or already in use'
  if (stderrTail.toLowerCase().includes('no such file or directory')) return 'Camera device not found (disconnected?)'
  if (stderrTail.toLowerCase().includes('permission denied')) return 'Camera access denied'
  const lastLine = stderrTail.trim().split(/\r?\n/).pop()
  return lastLine || 'Unknown ffmpeg error'
}

export const recordingEngine = new RecordingEngine()
