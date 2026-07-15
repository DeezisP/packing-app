import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildOverlayLines, formatHms } from '@shared/types'
import type { OverlayConfig } from '@shared/types'
import { logger } from './Logger'

interface OverlaySession {
  filePath: string
  timer: NodeJS.Timeout
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatTimeLocal(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Writes the small text file ffmpeg's drawtext filter burns into a
 *  recording (via `textfile=...:reload=1`), refreshing it once a second so
 *  the current time and elapsed-recording fields stay live. Barcode/station/
 *  camera are static for the life of one recording; only date/time/timer
 *  actually change between refreshes. */
class OverlayService {
  private sessions = new Map<string, OverlaySession>()

  private overlayDir(): string {
    const dir = path.join(os.tmpdir(), 'packing-recorder-overlays')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  start(
    stationId: string,
    config: OverlayConfig,
    staticData: { barcode: string; station: string; camera: string },
    startedAt: Date
  ): string {
    this.stop(stationId)

    const filePath = path.join(this.overlayDir(), `${stationId}.txt`)

    const write = (): void => {
      const now = new Date()
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
      const lines = buildOverlayLines(config, {
        barcode: staticData.barcode,
        date: formatDateLocal(now),
        time: formatTimeLocal(now),
        timer: formatHms(elapsedSeconds),
        station: staticData.station,
        camera: staticData.camera
      })
      try {
        fs.writeFileSync(filePath, lines.join('\n'))
      } catch (err) {
        logger.error('Failed to write overlay text file', { stationId, error: (err as Error).message })
      }
    }

    write()
    const timer = setInterval(write, 1000)
    this.sessions.set(stationId, { filePath, timer })
    return filePath
  }

  stop(stationId: string): void {
    const session = this.sessions.get(stationId)
    if (!session) return
    clearInterval(session.timer)
    fs.rm(session.filePath, { force: true }, () => undefined)
    this.sessions.delete(stationId)
  }
}

export const overlayService = new OverlayService()
