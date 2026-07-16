import { BrowserWindow, session, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'
import { logger } from '../services/Logger'
import { defaultPaths } from '../services/PathService'

export function createMainWindow(): BrowserWindow {
  // This is a trusted, fully offline kiosk app - webcam access is core to its
  // purpose, so auto-grant media permission instead of showing a prompt.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  // setPermissionRequestHandler alone only lets a getUserMedia() call
  // succeed - it does NOT make Chromium treat the origin as having a
  // standing grant. Without this separate check handler, every
  // navigator.mediaDevices.enumerateDevices() call keeps returning
  // permission-redacted entries (blank label, blank/unstable deviceId) even
  // after a successful getUserMedia() call, because Chromium's device-label
  // exposure is gated on this handler, not on request history. That silently
  // broke duplicate-camera disambiguation in useCameraPreview: with every
  // device unlabeled, its name-based device matching always found zero
  // matches and fell back to an unconstrained `getUserMedia({video: true})`,
  // which opens whatever Chromium considers the default device - the same
  // one - no matter which camera was actually requested.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0b0f',
    icon: defaultPaths.iconFile,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Surfaces renderer-side errors (failed IPC calls, camera preview issues) into
  // Logs/app.log so operators don't need to open DevTools to diagnose problems.
  // level: 0=verbose, 1=info, 2=warning, 3=error
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level === 3) {
      logger.error(`Renderer: ${message}`, { line, sourceId })
    } else if (level === 2) {
      logger.warn(`Renderer: ${message}`, { line, sourceId })
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}
