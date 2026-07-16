import { app } from 'electron'
import path from 'node:path'

// This module (and the ConfigManager that depends on it) gets imported and
// its module-level singleton constructed the moment index.ts runs, well
// before app.whenReady() - which is too early for Electron to have finished
// reading the app name from package.json yet, so app.getPath('userData')
// would otherwise silently resolve under the generic "Electron" fallback
// name instead of this app's own userData folder. Setting it explicitly
// here, matching package.json's "name", makes it correct regardless of
// import timing.
app.setName('packing-recorder')

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
    : null, // resolved from the ffmpeg-static package in dev, see FfmpegLocator
  iconFile: app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(appRoot, 'resources', 'icon.ico'),
  // Outside appRoot on purpose: NSIS install/update/uninstall only ever
  // touches files it shipped, so config.json living next to the .exe should
  // already be safe - but this is a zero-cost extra guarantee that survives
  // even a full reinstall to a different folder, since userData is a stable
  // per-user OS location electron manages independently of where the app
  // itself is installed.
  configBackupFile: path.join(app.getPath('userData'), 'config.backup.json'),
  // Pure ephemeral cache (one continuously-overwritten JPEG per station while
  // it's recording, see RecordingEngine's live-preview output branch) - OS
  // temp, not appRoot, since it has no reason to be portable or survive a
  // reinstall the way Videos/config/database do.
  previewCacheDir: path.join(app.getPath('temp'), 'packing-recorder-preview')
}

export function resolveSaveLocation(saveLocation: string): string {
  return path.isAbsolute(saveLocation) ? saveLocation : path.join(appRoot, saveLocation)
}

/** Where the single continuously-refreshed live-preview frame for a station
 *  lives while it's recording - see RecordingEngine.start()'s second ffmpeg
 *  output branch, which is the only thing that ever writes here. */
export function previewFramePath(stationId: string): string {
  return path.join(defaultPaths.previewCacheDir, `${stationId}.jpg`)
}
