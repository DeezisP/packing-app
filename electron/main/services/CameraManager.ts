import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import type { CameraDevice } from '@shared/types'

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
      JSON.stringify(result.video.map((d) => d.name).sort()) !==
        JSON.stringify(this.lastVideoDevices.map((d) => d.name).sort()) ||
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

  isDeviceConnected(name: string): boolean {
    return this.lastVideoDevices.some((d) => d.name === name)
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
    if (line.includes('Alternative name')) continue

    const match = line.match(/"([^"]+)"/)
    if (!match) continue

    if (section === 'video') {
      video.push({ name: match[1], index: videoIndex++, connected: true })
    } else if (section === 'audio') {
      audio.push(match[1])
    }
  }

  return { video, audio }
}

export const cameraManager = new CameraManager()
