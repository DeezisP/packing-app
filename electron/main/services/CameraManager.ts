import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { resolveStationCameraId } from '@shared/types'
import type { CameraDevice, StationConfig } from '@shared/types'

const POLL_INTERVAL_MS = 5000

/** Enumerates USB webcams (and microphones) visible to Windows via ffmpeg's
 *  DirectShow (dshow) device lister, and polls periodically so the UI can
 *  react to cameras being plugged in / unplugged. */
class CameraManager extends EventEmitter {
  private lastVideoDevices: CameraDevice[] = []
  private lastAudioDevices: string[] = []
  private pollTimer: NodeJS.Timeout | null = null

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
        resolve({ video: [], audio: [] })
      })
      child.on('close', () => {
        resolve(parseDshowOutput(stderr))
      })
      // ffmpeg with -list_devices exits on its own almost immediately; guard
      // against it ever hanging by force-killing after a short timeout.
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 8000)
    })
  }

  async listVideoDevices(): Promise<CameraDevice[]> {
    const { video } = await this.runDshowListing()
    this.lastVideoDevices = video
    return video
  }

  async listAudioDevices(): Promise<string[]> {
    const { audio } = await this.runDshowListing()
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
      logger.info('Camera/microphone device list changed', {
        video: result.video.map((d) => d.name),
        audio: result.audio
      })
      this.emit('changed', result)
    }
    return result
  }

  getLastKnownDevices(): CameraDevice[] {
    return this.lastVideoDevices
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

function parseDshowOutput(stderr: string): { video: CameraDevice[]; audio: string[] } {
  const lines = stderr.split(/\r?\n/)
  const video: CameraDevice[] = []
  const audio: string[] = []
  let section: 'video' | 'audio' | null = null
  let videoIndex = 0

  for (const line of lines) {
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

    if (section === 'video') {
      // `id` defaults to the friendly name and is overwritten by the
      // "Alternative name" line immediately below (handled above) when
      // ffmpeg's driver reports one - a driver that doesn't keeps working
      // exactly as before, just without duplicate-name disambiguation.
      video.push({ id: match[1], name: match[1], index: videoIndex++, connected: true })
    } else if (section === 'audio') {
      audio.push(match[1])
    }
  }

  return { video, audio }
}

export const cameraManager = new CameraManager()
