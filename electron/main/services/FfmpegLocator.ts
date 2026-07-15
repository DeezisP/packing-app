import { app } from 'electron'
import fs from 'node:fs'
import { defaultPaths } from './PathService'

let cachedPath: string | null = null

/** Resolves the ffmpeg.exe path. Packaged builds ship it under resources/ffmpeg,
 *  dev mode pulls it straight from the ffmpeg-static package already in node_modules. */
export function resolveFfmpegPath(): string {
  if (cachedPath) return cachedPath

  if (app.isPackaged && defaultPaths.ffmpegBinary) {
    if (!fs.existsSync(defaultPaths.ffmpegBinary)) {
      throw new Error(`Bundled ffmpeg binary not found at ${defaultPaths.ffmpegBinary}`)
    }
    cachedPath = defaultPaths.ffmpegBinary
    return cachedPath
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpegStaticPath = require('ffmpeg-static') as string
  cachedPath = ffmpegStaticPath
  return cachedPath
}
