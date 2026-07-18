import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { resolveStationCameraId } from '@shared/types'
import type { CameraDevice, StationConfig, CameraCapabilityOption } from '@shared/types'

const POLL_INTERVAL_MS = 5000

/** Enumerates USB webcams (and microphones) visible to Windows via ffmpeg's
 *  DirectShow (dshow) device lister, and polls periodically so the UI can
 *  react to cameras being plugged in / unplugged.
 *
 *  Camera *ownership* is not this class's concern - two different things
 *  open a station's camera at different times, and only one may hold it at
 *  once (confirmed against real hardware: this UVC camera rejects a second
 *  concurrent open outright). The renderer's getUserMedia() preview holds it
 *  for as long as a dashboard card is mounted and no recording is active;
 *  LiveRecordingService's ffmpeg process holds it exclusively for the
 *  duration of an actual recording, handed off via the release/resume
 *  handshake StationManager drives (see CameraPreviewReleaseRequest in
 *  shared/types.ts). The isolated Diagnostics "Test Recording" flow
 *  (RecordingEngine.testRecording) needs no part of that handshake - Settings
 *  and Dashboard are mutually-exclusive tabs in the one renderer window, so
 *  the live preview is already unmounted (and its getUserMedia track
 *  stopped) by the time that flow can run. */
class CameraManager extends EventEmitter {
  private lastVideoDevices: CameraDevice[] = []
  private lastAudioDevices: string[] = []
  private lastRawOutput = ''
  private pollTimer: NodeJS.Timeout | null = null
  private capabilitiesCache = new Map<string, CameraCapabilityOption[]>()
  private capabilitiesInFlight = new Map<string, Promise<CameraCapabilityOption[]>>()

  private runDshowListing(): Promise<{ video: CameraDevice[]; audio: string[] }> {
    return new Promise((resolve) => {
      const ffmpegPath = resolveFfmpegPath()
      const child = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        logger.error('Failed to spawn ffmpeg for device listing', { error: err.message })
        this.lastRawOutput = ''
        resolve({ video: [], audio: [] })
      })
      child.on('close', () => {
        this.lastRawOutput = stderr
        resolve(parseDshowOutput(stderr))
      })
      // ffmpeg with -list_devices exits on its own almost immediately; guard
      // against it ever hanging by force-killing after a short timeout.
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 8000)
    })
  }

  /** Raw ffmpeg dshow stderr from the most recent listing - surfaced on the
   *  Diagnostics page so a mismatch between what ffmpeg actually printed and
   *  what got parsed out of it is visible without reading log files. */
  getLastRawOutput(): string {
    return this.lastRawOutput
  }

  async listVideoDevices(): Promise<CameraDevice[]> {
    const { video, audio } = await this.runDshowListing()
    this.lastVideoDevices = video
    this.lastAudioDevices = audio
    logEnumeration(video, audio)
    return video
  }

  async listAudioDevices(): Promise<string[]> {
    const { video, audio } = await this.runDshowListing()
    this.lastVideoDevices = video
    this.lastAudioDevices = audio
    return audio
  }

  async refresh(): Promise<{ video: CameraDevice[]; audio: string[] }> {
    const result = await this.runDshowListing()
    const changed =
      JSON.stringify(result.video.map((d) => d.id).sort()) !==
        JSON.stringify(this.lastVideoDevices.map((d) => d.id).sort()) ||
      JSON.stringify(result.audio.sort()) !== JSON.stringify(this.lastAudioDevices.sort())

    this.lastVideoDevices = result.video
    this.lastAudioDevices = result.audio

    if (changed) {
      logEnumeration(result.video, result.audio)
      this.emit('changed', result)
    }
    this.prewarmCapabilities(result.video)
    return result
  }

  getLastKnownDevices(): CameraDevice[] {
    return this.lastVideoDevices
  }

  /** Resolutions/frame-rates a specific camera actually reports supporting
   *  (via ffmpeg's `-list_options`), cached per device id for the life of the
   *  process - probing spawns ffmpeg and briefly opens the device, so it's
   *  only worth doing once per camera rather than before every recording
   *  start. Concurrent callers for the same id share one in-flight probe
   *  instead of racing duplicate ffmpeg processes against each other. */
  async getCapabilities(cameraId: string): Promise<CameraCapabilityOption[]> {
    const cached = this.capabilitiesCache.get(cameraId)
    if (cached) return cached

    const inFlight = this.capabilitiesInFlight.get(cameraId)
    if (inFlight) return inFlight

    const promise = this.probeCapabilities(cameraId)
    this.capabilitiesInFlight.set(cameraId, promise)
    try {
      const result = await promise
      this.capabilitiesCache.set(cameraId, result)
      return result
    } finally {
      this.capabilitiesInFlight.delete(cameraId)
    }
  }

  private probeCapabilities(cameraId: string): Promise<CameraCapabilityOption[]> {
    return new Promise((resolve) => {
      const ffmpegPath = resolveFfmpegPath()
      const child = spawn(ffmpegPath, [
        '-hide_banner',
        '-f',
        'dshow',
        '-list_options',
        'true',
        '-i',
        `video=${cameraId}`
      ])
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        logger.warn('Camera capability probe failed to start', { cameraId, error: err.message })
        resolve([])
      })
      child.on('close', () => {
        const capabilities = parseDshowOptions(stderr)
        logger.info('Camera capability probe complete', { cameraId, modes: capabilities.length })
        resolve(capabilities)
      })
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 8000)
    })
  }

  /** Fire-and-forget background probing for every currently-known camera not
   *  already cached, so the first barcode scan at a station doesn't pay the
   *  ~1-2s ffmpeg probe cost - by the time a scan happens the answer is
   *  usually already cached. Never blocks or throws into the caller. */
  private prewarmCapabilities(devices: CameraDevice[]): void {
    for (const device of devices) {
      if (this.capabilitiesCache.has(device.id) || this.capabilitiesInFlight.has(device.id)) continue
      this.getCapabilities(device.id).catch(() => undefined)
    }
  }

  /** Resolves a station's configured camera against the most recently
   *  polled device list - id-first, name-fallback (see resolveStationCameraId) -
   *  and reports whether that specific physical device is currently present.
   *  This is the one place recording, connected-status, and display-name
   *  resolution all funnel through, so they can never disagree with each
   *  other about which physical camera a station means. */
  resolveStationCamera(station: Pick<StationConfig, 'cameraId' | 'cameraName'>): CameraDevice | null {
    const id = resolveStationCameraId(station, this.lastVideoDevices)
    if (!id) return null
    return this.lastVideoDevices.find((d) => d.id === id) ?? null
  }

  startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      this.refresh().catch((err) => logger.error('Camera polling failed', { error: (err as Error).message }))
    }, POLL_INTERVAL_MS)
    this.refresh().catch((err) => logger.error('Initial camera scan failed', { error: (err as Error).message }))
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}

/** Parses ffmpeg's `-f dshow -list_devices true` stderr output.
 *
 *  ROOT CAUSE (see root-cause report): this function used to require a
 *  section-header line ("DirectShow video devices" / "DirectShow audio
 *  devices") to know whether a subsequent `"Name"` line was a camera or a
 *  microphone. ffmpeg 5.x/6.x (including the ffmpeg-static 6.1.1 build this
 *  app ships) no longer prints those headers at all - every device line is
 *  self-tagged inline instead, e.g. `"EMEET SmartCam S600" (video)`. With no
 *  header ever appearing, `section` stayed `null` forever and EVERY device -
 *  not just the second identical camera - was silently dropped, regardless
 *  of how many physical cameras Windows reported. Verified by running the
 *  actual bundled ffmpeg.exe against two physical EMEET SmartCam S600
 *  webcams: raw stderr correctly lists both with distinct "Alternative name"
 *  DirectShow paths, but the old parser produced an empty array from that
 *  exact output.
 *
 *  Fixed by reading the type from each device line's own inline tag first,
 *  which is what every currently-shipping ffmpeg build prints. The
 *  header-line tracking is kept as a fallback for older ffmpeg builds that
 *  predate the inline tag and never had one, so both output generations
 *  parse correctly instead of special-casing one exact version. */
function parseDshowOutput(stderr: string): { video: CameraDevice[]; audio: string[] } {
  const lines = stderr.split(/\r?\n/)
  const video: CameraDevice[] = []
  const audio: string[] = []
  let section: 'video' | 'audio' | null = null
  let videoIndex = 0

  for (const line of lines) {
    // Older ffmpeg builds (pre-5.x) group devices under these headers with
    // no per-line type tag - kept as the fallback path, see doc comment above.
    if (line.includes('DirectShow video devices')) {
      section = 'video'
      continue
    }
    if (line.includes('DirectShow audio devices')) {
      section = 'audio'
      continue
    }

    if (line.includes('Alternative name')) {
      // Belongs to whichever device was just listed above it - this is the
      // one piece of ffmpeg's output that's actually unique per physical
      // device (two identical camera models still get two different
      // alternative-name paths), so it becomes that device's `id`. Only
      // video devices need a unique id here; audio device selection isn't
      // part of this fix.
      if (section === 'video' && video.length > 0) {
        const altMatch = line.match(/"([^"]+)"/)
        if (altMatch) video[video.length - 1].id = altMatch[1]
      }
      continue
    }

    const match = line.match(/"([^"]+)"/)
    if (!match) continue

    // Current ffmpeg builds tag every device line inline - this is the
    // primary signal. Only fall back to the header-tracked `section` when a
    // line has no inline tag, for a build old enough to lack one entirely.
    const inlineType = line.includes('(video)') ? 'video' : line.includes('(audio)') ? 'audio' : null
    const type = inlineType ?? section

    if (type === 'video') {
      section = 'video'
      // `id` defaults to the friendly name and is overwritten by the
      // "Alternative name" line immediately below (handled above) when
      // ffmpeg's driver reports one - a driver that doesn't keeps working
      // exactly as before, just without duplicate-name disambiguation.
      video.push({ id: match[1], name: match[1], index: videoIndex++, connected: true })
    } else if (type === 'audio') {
      section = 'audio'
      audio.push(match[1])
    }
  }

  return { video, audio }
}

/** Parses ffmpeg's `-f dshow -list_options true` stderr output into the
 *  discrete (width, height, max fps) modes a device supports. Real-world
 *  dshow drivers print one line per pixel format per resolution, e.g.:
 *    vcodec=mjpeg  min s=640x480 fps=5 max s=640x480 fps=30
 *  When min/max resolution match (by far the common case for UVC webcams),
 *  that's one discrete mode whose achievable frame rate tops out at the
 *  "max fps" value. A driver that instead reports a genuine range across
 *  differing min/max resolutions has both endpoints recorded as separate
 *  modes - an approximation, but a safe one: it only ever under-reports
 *  capability (never claims support for a mode that was never mentioned).
 *  Multiple pixel formats can report the same resolution; the highest fps
 *  seen for a given resolution across all of them wins, since ffmpeg is free
 *  to pick whichever pixel format satisfies the requested mode. */
function parseDshowOptions(stderr: string): CameraCapabilityOption[] {
  const regex = /min s=(\d+)x(\d+) fps=([\d.]+) max s=(\d+)x(\d+) fps=([\d.]+)/g
  const byResolution = new Map<string, CameraCapabilityOption>()

  let match: RegExpExecArray | null
  while ((match = regex.exec(stderr)) !== null) {
    const [, minW, minH, minFps, maxW, maxH, maxFps] = match
    const points: Array<[number, number, number]> = [
      [Number(minW), Number(minH), Number(minFps)],
      [Number(maxW), Number(maxH), Number(maxFps)]
    ]
    for (const [width, height, fps] of points) {
      const key = `${width}x${height}`
      const existing = byResolution.get(key)
      if (!existing || fps > existing.maxFps) {
        byResolution.set(key, { width, height, maxFps: fps })
      }
    }
  }

  return Array.from(byResolution.values())
}

/** Logs the exact per-device breakdown requested for camera-pipeline
 *  diagnostics: friendly name, the unique id ffmpeg is actually told to
 *  open, and enumeration index, for every currently-detected camera. Called
 *  on every UI-triggered listing and whenever the polled list changes (not
 *  on every unchanged 5s poll, to avoid flooding the log file). */
function logEnumeration(video: CameraDevice[], audio: string[]): void {
  const lines = ['Enumerating Cameras...']
  if (video.length === 0) {
    lines.push('  (no DirectShow video capture devices reported by ffmpeg)')
  }
  video.forEach((cam, i) => {
    lines.push(`Camera ${i + 1}`)
    lines.push(`  Friendly Name: ${cam.name}`)
    lines.push(`  Device ID (ffmpeg dshow "Alternative name"): ${cam.id}`)
    lines.push(`  Enumeration Index: ${cam.index}`)
    lines.push('--------------------------')
  })
  logger.info(lines.join('\n'), { videoCount: video.length, audioCount: audio.length })
}

export const cameraManager = new CameraManager()
