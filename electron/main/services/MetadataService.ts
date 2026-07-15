import fs from 'node:fs'
import path from 'node:path'
import { logger } from './Logger'
import { formatHms } from '@shared/types'
import type { RecordingMetadata } from '@shared/types'

/** Writes metadata.json next to packing.mp4 - a plain-file, human-readable
 *  companion to the database row for anyone processing the Videos/ folder
 *  directly without going through the app. Best-effort: a failure here
 *  never affects the recording itself, which is already saved by this point. */
export function writeRecordingMetadata(input: {
  videoPath: string
  barcode: string
  station: string
  camera: string
  startedAt: Date
  endedAt: Date
  resolution: string
  fps: number
}): void {
  try {
    const durationSeconds = Math.max(0, Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000))
    const fileSize = fs.existsSync(input.videoPath) ? fs.statSync(input.videoPath).size : 0

    const metadata: RecordingMetadata = {
      barcode: input.barcode,
      station: input.station,
      camera: input.camera,
      startTime: input.startedAt.toISOString(),
      endTime: input.endedAt.toISOString(),
      duration: formatHms(durationSeconds),
      resolution: input.resolution,
      fps: input.fps,
      fileSize
    }

    const metadataPath = path.join(path.dirname(input.videoPath), 'metadata.json')
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
  } catch (err) {
    logger.error('Failed to write recording metadata.json', {
      videoPath: input.videoPath,
      error: (err as Error).message
    })
  }
}
