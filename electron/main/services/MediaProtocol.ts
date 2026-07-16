import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import type { PlaybackPreflightResult } from '@shared/types'

export const MEDIA_SCHEME = 'packing-media'

// Must run before app.whenReady() - privileged schemes have to be declared
// at module load time so the renderer is allowed to fetch/stream from them.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { secure: true, standard: true, stream: true, bypassCSP: true, supportFetchAPI: true }
  }
])

/** Serves local video/thumbnail files to the renderer without relying on
 *  raw file:// access, which Electron blocks/CORS-restricts inconsistently
 *  between the dev server origin and the packaged file:// origin.
 *
 *  ROOT CAUSE of "plays in VLC/Windows Media Player but not in the built-in
 *  player": an HTML5 <video> element doesn't just GET the whole file - it
 *  probes the resource with ranged requests (`Range: bytes=...`) to
 *  determine seekability and size before it will commit to playing
 *  anything. The previous version of this handler built a brand-new
 *  request with `net.fetch(fileUrl)` and no headers at all, so every
 *  request - ranged or not - came back as a full 200 response. Chromium's
 *  media pipeline treats a resource that never answers a Range request
 *  with 206/Content-Range as effectively non-seekable/unplayable and
 *  fails the load, even though the file itself is completely valid (which
 *  is exactly why the same file opened directly, or in an external player
 *  that doesn't negotiate ranges over HTTP, worked fine). Forwarding the
 *  incoming request's headers - notably Range - to the underlying file://
 *  fetch lets Electron's own file loader (which already implements Range
 *  correctly) answer properly. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    // Strip any query string before decoding the path - callers polling a
    // continuously-overwritten file (see the live recording-preview frame)
    // append a cache-busting `?t=...` to force a fresh read past any HTTP
    // caching, which must never become part of the file path itself.
    const withoutScheme = request.url.replace(`${MEDIA_SCHEME}://`, '').split('?')[0]
    const absolutePath = decodeURIComponent(withoutScheme)
    const fileUrl = pathToFileURL(absolutePath).toString()
    return net.fetch(fileUrl, { headers: request.headers })
  })
}

export function toMediaUrl(absolutePath: string): string {
  return `${MEDIA_SCHEME}://${encodeURIComponent(absolutePath)}`
}

/** Cheap existence/readability/signature check for the player to run before
 *  it sets a <video> src - see PlaybackPreflightResult. Deliberately does
 *  NOT decode the file (RecordingEngine.verifyRecording already did that
 *  once, at recording-stop time, before the recording was ever marked
 *  completed) - this only needs to catch the file having gone missing,
 *  become unreadable, or been swapped out from under the database since
 *  then. */
export function checkFileForPlayback(videoPath: string): PlaybackPreflightResult {
  if (!fs.existsSync(videoPath)) {
    return { exists: false, readable: false, locked: false, sizeBytes: 0, looksLikeValidMp4: false, error: 'ไม่พบไฟล์วิดีโอ - ไฟล์อาจถูกย้ายหรือลบ' }
  }

  let sizeBytes = 0
  try {
    sizeBytes = fs.statSync(videoPath).size
  } catch (err) {
    return { exists: true, readable: false, locked: false, sizeBytes: 0, looksLikeValidMp4: false, error: (err as Error).message }
  }

  let fd: number | null = null
  try {
    fd = fs.openSync(videoPath, 'r')
    const header = Buffer.alloc(12)
    fs.readSync(fd, header, 0, 12, 0)
    // The MP4/MOV family's first box is `ftyp`, 4 bytes into the file
    // (after a 4-byte big-endian box size) - a reliable, cheap signature
    // check without decoding anything.
    const looksLikeValidMp4 = header.toString('ascii', 4, 8) === 'ftyp'
    return {
      exists: true,
      readable: true,
      locked: false,
      sizeBytes,
      looksLikeValidMp4,
      error: looksLikeValidMp4 ? null : 'ไฟล์นี้ไม่ใช่ไฟล์ MP4 ที่ถูกต้อง (ไม่พบ ftyp box)'
    }
  } catch (err) {
    return {
      exists: true,
      readable: false,
      locked: true,
      sizeBytes,
      looksLikeValidMp4: false,
      error: (err as Error).message
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // best-effort close
      }
    }
  }
}
