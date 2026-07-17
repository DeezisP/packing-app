import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { summarizeFfmpegError } from './RecordingEngine'

const END_SESSION_TIMEOUT_MS = 8000

interface Session {
  stationId: string
  filePath: string
  stream: fs.WriteStream
  bytesWritten: number
  /** Chains every chunk write so each one only starts after the previous
   *  both wrote and, if the stream signaled backpressure, drained - plain
   *  fire-and-forget writes could let an unbounded backlog build up in
   *  memory if disk throughput falls behind chunk arrival (worst case:
   *  several stations' streams landing on one disk at once at the highest
   *  quality preset). */
  writeQueue: Promise<void>
  endResolvers: Array<(result: { capturePath: string; bytesWritten: number }) => void>
  ended: boolean
}

function writeAndDrain(stream: fs.WriteStream, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buffer, (err) => {
      if (err) reject(err)
    })
    if (ok) {
      resolve()
    } else {
      stream.once('drain', resolve)
    }
  })
}

/** Receives the renderer's live MediaRecorder capture (see
 *  useRecordingCapture.ts) as a stream of webm chunks over IPC, writes them
 *  to a local `capture.webm` file, and - once a recording stops - transcodes
 *  that completed, static file to the final `packing.mp4` via a one-shot
 *  ffmpeg call. This is the main process's entire role in recording now: it
 *  never opens the camera itself. Every chunk is byte-concatenated onto the
 *  write stream in arrival order, which reconstructs a valid webm file -
 *  this relies on MediaRecorder's well-established chunking behavior (the
 *  first blob carries the webm header + first cluster, each subsequent blob
 *  is a complete following cluster), not an assumption specific to this app. */
class CaptureIngestService extends EventEmitter {
  private sessions = new Map<string, Session>()
  private transcodes = new Map<string, ChildProcess>()

  beginSession(input: { sessionId: string; stationId: string; outputDir: string }): void {
    const filePath = path.join(input.outputDir, 'capture.webm')
    const stream = fs.createWriteStream(filePath)
    this.sessions.set(input.sessionId, {
      stationId: input.stationId,
      filePath,
      stream,
      bytesWritten: 0,
      writeQueue: Promise.resolve(),
      endResolvers: [],
      ended: false
    })
    logger.info('Capture session started', { sessionId: input.sessionId, stationId: input.stationId, filePath })
  }

  /** `final: true` (sent only after the renderer's MediaRecorder.stop()
   *  `onstop` event fires, guaranteeing every real chunk already went out -
   *  see useRecordingCapture.ts) closes the file once every prior chunk in
   *  this session has actually been written. A chunk whose `sessionId`
   *  doesn't match a currently-open session (a stray late arrival from an
   *  already-finished/timed-out session, or a bug) is dropped and logged,
   *  never written - sessions are never keyed by stationId alone precisely
   *  so an overlapping new/old recording pair for the same station can never
   *  collide here. */
  writeChunk(input: { sessionId: string; seq: number; data: ArrayBuffer; final: boolean }): void {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      logger.warn('Capture chunk received for unknown/closed session, dropping', {
        sessionId: input.sessionId,
        seq: input.seq
      })
      return
    }
    if (session.ended) return

    if (input.data.byteLength > 0) {
      const buffer = Buffer.from(input.data)
      session.bytesWritten += buffer.length
      session.writeQueue = session.writeQueue
        .then(() => writeAndDrain(session.stream, buffer))
        .catch((err) => {
          logger.error('Capture chunk write failed', { sessionId: input.sessionId, error: (err as Error).message })
        })
    }

    if (input.final) {
      session.writeQueue = session.writeQueue.then(() => this.finishSession(input.sessionId))
    }
  }

  private finishSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) return
    session.ended = true
    this.sessions.delete(sessionId)
    session.stream.end(() => {
      logger.info('Capture session finalized', {
        sessionId,
        stationId: session.stationId,
        bytesWritten: session.bytesWritten,
        filePath: session.filePath
      })
      const result = { capturePath: session.filePath, bytesWritten: session.bytesWritten }
      session.endResolvers.forEach((resolve) => resolve(result))
    })
  }

  /** Waits for the session's final chunk to arrive and be fully flushed to
   *  disk before resolving, so the caller never starts transcoding a file
   *  that's still being written. Falls back to finalizing with whatever
   *  bytes actually arrived if the renderer never confirms within
   *  `timeoutMs` (a hung/crashed renderer, a dropped IPC message) - the
   *  resulting file then flows into the existing transcode/verify failure
   *  path exactly like any other corrupt input, no bespoke handling needed. */
  async endSession(
    sessionId: string,
    timeoutMs = END_SESSION_TIMEOUT_MS
  ): Promise<{ capturePath: string; bytesWritten: number }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`No active capture session: ${sessionId}`)
    }

    const finished = new Promise<{ capturePath: string; bytesWritten: number }>((resolve) => {
      session.endResolvers.push(resolve)
    })

    let timeoutHandle: NodeJS.Timeout
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    const winner = await Promise.race([finished, timedOut])
    clearTimeout(timeoutHandle!)
    if (winner !== 'timeout') return winner

    logger.warn('Capture session did not confirm its final chunk in time, finalizing with whatever was received', {
      sessionId,
      bytesWritten: session.bytesWritten
    })
    this.finishSession(sessionId)
    return finished
  }

  /** Renderer-reported hard failure (mic device missing, unsupported
   *  MediaRecorder mimeType, etc.) - mirrors the old RecordingEngine's
   *  `unexpectedExit` event so StationManager's handling stays the same
   *  shape. Destroys any partial file rather than leaving a stream open. */
  reportCaptureError(sessionId: string, stationId: string, message: string): void {
    logger.error('Capture error reported by renderer', { sessionId, stationId, message })
    const session = this.sessions.get(sessionId)
    if (session && !session.ended) {
      session.ended = true
      this.sessions.delete(sessionId)
      session.stream.destroy()
    }
    this.emit('captureError', { sessionId, stationId, message })
  }

  /** One-shot, non-live transcode of a completed capture file to the final
   *  mp4 - the same safe, static-input-file ffmpeg usage pattern as
   *  RecordingEngine's verifyRecording/generateThumbnail, never a live
   *  device. Overlay text is already burned in by the renderer's canvas
   *  compositing (see useRecordingCapture.ts/canvasOverlay.ts) before this
   *  ever runs, so no filter graph is needed here - just a codec switch. */
  async transcodeToMp4(input: {
    sessionId: string
    capturePath: string
    outputPath: string
    bitrateKbps: number
    hasAudio: boolean
  }): Promise<{ success: boolean; error: string | null }> {
    const ffmpegPath = resolveFfmpegPath()
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      input.capturePath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      `${input.bitrateKbps}k`,
      ...(input.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags',
      '+faststart',
      input.outputPath
    ]

    logger.info('Transcode: starting webm -> mp4', {
      capturePath: input.capturePath,
      outputPath: input.outputPath,
      commandLine: `${ffmpegPath} ${args.join(' ')}`
    })

    return new Promise((resolve) => {
      let stderr = ''
      const child = spawn(ffmpegPath, args)
      this.transcodes.set(input.sessionId, child)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('exit', (code) => {
        this.transcodes.delete(input.sessionId)
        const success = code === 0
        if (success) {
          logger.info('Transcode succeeded', { capturePath: input.capturePath, outputPath: input.outputPath })
        } else {
          logger.error('Transcode failed', { capturePath: input.capturePath, code, stderr: stderr.slice(-4000) })
        }
        resolve({ success, error: success ? null : summarizeFfmpegError(stderr) })
      })
      child.on('error', (err) => {
        this.transcodes.delete(input.sessionId)
        logger.error('Transcode process failed to start', { error: err.message })
        resolve({ success: false, error: err.message })
      })
    })
  }

  /** Force-closes open write streams and kills in-flight transcodes without
   *  waiting - used on app quit so shutdown never hangs. Any session or
   *  transcode still in flight at this point is picked up (or at least
   *  logged as a leftover `capture.webm`) the next time the app starts. */
  killAll(): void {
    for (const session of this.sessions.values()) {
      session.ended = true
      try {
        session.stream.destroy()
      } catch {
        // best-effort
      }
    }
    this.sessions.clear()

    for (const child of this.transcodes.values()) {
      child.kill('SIGKILL')
    }
    this.transcodes.clear()
  }
}

export const captureIngestService = new CaptureIngestService()
