import net from 'node:net'
import { EventEmitter } from 'node:events'
import { logger } from './Logger'

const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])

interface ActiveStream {
  server: net.Server
  socket: net.Socket | null
  buffer: Buffer
}

/** Streams a low-res/low-fps MJPEG side-channel from the recording ffmpeg
 *  process's own second output leg back to the renderer, so the operator
 *  sees a genuinely live feed while ffmpeg holds exclusive use of the camera
 *  (see RecordingEngine.buildRecordArgs for the ffmpeg side of this).
 *
 *  A Windows named pipe - not a rotating preview file - is the transport,
 *  specifically because an earlier attempt using ffmpeg's image2 muxer
 *  writing to a repeatedly-overwritten file was tried and reverted: its
 *  per-frame open/overwrite/close cycle raced the renderer reading that same
 *  file and occasionally stalled ffmpeg's graceful 'q' shutdown long enough
 *  to hit the SIGKILL fallback, which produced an unplayable recording (no
 *  moov atom). A named pipe is opened exactly once for the life of the
 *  recording, so there is no per-frame file I/O to contend over.
 *
 *  Two invariants keep this side-channel from ever risking the actual
 *  recording: (1) the server here always starts listening *before* ffmpeg is
 *  spawned, so ffmpeg's own pipe-open can never block waiting on a reader
 *  that isn't there yet, and (2) every socket is drained unconditionally (no
 *  backpressure is ever applied), so ffmpeg's writes to this leg can never
 *  block. If this leg errors or the connection drops, it's logged and
 *  dropped - it is a second, independent output in ffmpeg's command, so
 *  losing it doesn't touch the primary mp4 output at all. */
class PreviewStreamService extends EventEmitter {
  private streams = new Map<string, ActiveStream>()

  private pipePath(stationId: string): string {
    return `\\\\.\\pipe\\packing-preview-${stationId}`
  }

  /** Starts listening for this station's ffmpeg preview connection and
   *  resolves with the pipe path to pass as that output's URL once the
   *  server is actually listening - never before, so ffmpeg is never handed
   *  a pipe path nothing is serving yet. Resolves `null` if the server
   *  itself fails to start (e.g. a name collision left over from a previous
   *  run) instead of hanging forever, so a live-preview failure can never
   *  block a recording from starting - the caller just skips the preview
   *  output branch entirely in that case. */
  start(stationId: string): Promise<string | null> {
    this.stop(stationId)
    const pipePath = this.pipePath(stationId)

    return new Promise((resolve) => {
      let settled = false

      const server = net.createServer((socket) => {
        const stream = this.streams.get(stationId)
        if (stream) stream.socket = socket
        socket.on('data', (chunk: Buffer) => this.onData(stationId, chunk))
        socket.on('error', (err) => {
          logger.warn('Live preview: pipe connection error (recording unaffected)', {
            stationId,
            error: err.message
          })
        })
        socket.on('close', () => {
          const s = this.streams.get(stationId)
          if (s) s.socket = null
        })
      })

      server.on('error', (err) => {
        logger.warn('Live preview: pipe server unavailable, recording will proceed without live view', {
          stationId,
          error: err.message
        })
        this.streams.delete(stationId)
        if (!settled) {
          settled = true
          resolve(null)
        }
      })

      this.streams.set(stationId, { server, socket: null, buffer: Buffer.alloc(0) })
      server.listen(pipePath, () => {
        if (!settled) {
          settled = true
          resolve(pipePath)
        }
      })
    })
  }

  private onData(stationId: string, chunk: Buffer): void {
    const stream = this.streams.get(stationId)
    if (!stream) return
    stream.buffer = stream.buffer.length ? Buffer.concat([stream.buffer, chunk]) : chunk

    // Extracts every complete JPEG frame (SOI..EOI) currently buffered,
    // tolerating leading garbage before the first SOI - ffmpeg's mjpeg
    // muxer writes complete frames back to back with nothing else in
    // between, but a connection observed mid-frame could leave a partial
    // one at the very front the first time this runs.
    for (;;) {
      const start = stream.buffer.indexOf(SOI)
      if (start === -1) {
        stream.buffer = Buffer.alloc(0)
        break
      }
      const end = stream.buffer.indexOf(EOI, start + SOI.length)
      if (end === -1) {
        if (start > 0) stream.buffer = stream.buffer.subarray(start)
        break
      }
      const frame = new Uint8Array(stream.buffer.subarray(start, end + EOI.length))
      stream.buffer = stream.buffer.subarray(end + EOI.length)
      this.emit('frame', { stationId, jpeg: frame })
    }
  }

  /** Tears down this station's pipe server/connection - safe to call even
   *  when nothing is active. Called on every ffmpeg exit path (graceful
   *  stop, unexpected exit, failed start) so a stale server can never block
   *  the next recording's pipe of the same name. */
  stop(stationId: string): void {
    const stream = this.streams.get(stationId)
    if (!stream) return
    this.streams.delete(stationId)
    try {
      stream.socket?.destroy()
    } catch {
      // best-effort - the connection may already be gone
    }
    try {
      stream.server.close()
    } catch {
      // best-effort
    }
  }
}

export const previewStreamService = new PreviewStreamService()
