import { app } from 'electron'
import path from 'node:path'

/**
 * Resolves the "portable root" the app writes all of its data into.
 * In dev this is the project folder itself; in a packaged build it is the
 * folder the installed .exe lives in, so Videos/Logs/config/database always
 * travel together with the application - no per-user AppData scattering.
 */
function resolveAppRoot(): string {
  if (app.isPackaged) {
    return path.dirname(app.getPath('exe'))
  }
  return process.cwd()
}

export const appRoot = resolveAppRoot()

export const defaultPaths = {
  configFile: path.join(appRoot, 'config.json'),
  configDefaultFile: app.isPackaged
    ? path.join(process.resourcesPath, 'config.default.json')
    : path.join(appRoot, 'config.default.json'),
  databaseFile: path.join(appRoot, 'database.sqlite'),
  logsDir: path.join(appRoot, 'Logs'),
  videosDir: path.join(appRoot, 'Videos'),
  ffmpegBinary: app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : null // resolved from the ffmpeg-static package in dev, see FfmpegLocator
}

export function resolveSaveLocation(saveLocation: string): string {
  return path.isAbsolute(saveLocation) ? saveLocation : path.join(appRoot, saveLocation)
}
