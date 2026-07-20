import { app, BrowserWindow, Menu, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerMediaProtocol } from './services/MediaProtocol'
import { createMainWindow } from './windows/createMainWindow'
import { buildAppMenu } from './windows/appMenu'
import { registerIpcHandlers } from './ipc/registerIpcHandlers'
import { configManager } from './services/ConfigManager'
import { logger } from './services/Logger'
import { database } from './services/Database'
import { cameraManager } from './services/CameraManager'
import { scannerManager } from './services/ScannerManager'
import { rawInputService } from './services/RawInputService'
import { stationManager } from './services/StationManager'
import { updateService } from './services/UpdateService'
import { apiQueueService } from './services/ApiQueueService'
import { recordingEngine } from './services/RecordingEngine'
import { persistentCaptureService } from './services/PersistentCaptureService'

const AUTO_UPDATE_CHECK_DELAY_MS = 8000

/** Best-effort checkpoint before/after each startup step - if the app fails
 *  to launch on some other machine, the last "startup: X" line in
 *  Logs/app.log (or its total absence, meaning it never even got past
 *  logger.init()) identifies exactly which step never completed. Swallows
 *  its own errors since some call sites run before Logger is guaranteed
 *  ready. */
function logStep(name: string): void {
  try {
    logger.info(`startup: ${name}`)
  } catch {
    // pre-init, ignored intentionally
  }
}

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      electronApp.setAppUserModelId('com.packingrecorder.app')

      // Initialized first, ahead of every other step below, so every
      // subsequent failure in this block - including ones that used to run
      // before this call - has somewhere to actually write to.
      logger.init()
      logger.info('Application starting', { version: app.getVersion(), packaged: app.isPackaged })

      logStep('ensureDirectories')
      configManager.ensureDirectories()

      logStep('database.init')
      await database.init()
      const recovered = database.recoverOrphanedRecordings()
      if (recovered > 0) {
        logger.warn('Previous session ended unexpectedly, recordings marked interrupted', { count: recovered })
      }

      applyAutoStartSetting()
      configManager.on('changed', applyAutoStartSetting)

      logStep('persistentCaptureService.init')
      persistentCaptureService.init()
      logStep('stationManager.init')
      stationManager.init()
      cameraManager.startPolling()
      scannerManager.startPolling()
      apiQueueService.start()
      registerMediaProtocol()
      registerIpcHandlers()

      // Hardware detection up front, not just lazily on the first recording -
      // a missing/broken ffmpeg install surfaces as one clear, early log entry
      // instead of only failing the moment an operator scans a barcode, and
      // the encoder probe (a real, multi-second GPU encode attempt per
      // candidate - see RecordingEngine.detectEncoder) is already done by the
      // time anyone actually starts recording. Neither blocks window creation
      // or app startup - a machine with no camera/ffmpeg configured yet still
      // launches normally; recording just won't work until that's fixed,
      // reported per-attempt with a clear message like every other expected
      // failure in this app.
      void recordingEngine.verifyFfmpegAvailable()
      void recordingEngine.detectEncoder()

      updateService.init()
      Menu.setApplicationMenu(buildAppMenu())
      if (app.isPackaged) {
        // Silent background check shortly after launch so the Dashboard badge
        // can show up on its own, without requiring the operator to go dig
        // through Settings first.
        setTimeout(() => {
          void updateService.check()
        }, AUTO_UPDATE_CHECK_DELAY_MS)
      }

      logStep('createMainWindow')
      const mainWindow = createMainWindow()
      // Raw Input registration needs a real native window handle, so this can
      // only happen after the window exists - unlike the other services above.
      rawInputService.init(mainWindow)
      logStep('startup complete')

      // Live camera capture is owned entirely by PersistentCaptureService in
      // this process, independent of any renderer window's lifecycle - a
      // renderer crash never interrupts an in-progress recording or the live
      // preview's underlying capture at all. The live *view* of it in the
      // crashed window is gone until a new window mounts and reattaches to
      // the still-running capture (see useLiveCapturePreview), so recreate it
      // and re-register Raw Input against the new native window handle.
      mainWindow.webContents.on('render-process-gone', (_event, details) => {
        logger.error('Renderer process gone', { reason: details.reason, exitCode: details.exitCode })
        const recreated = createMainWindow()
        rawInputService.init(recreated)
      })

      app.on('browser-window-created', (_e, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    } catch (err) {
      // Without this, any exception anywhere above only ever reaches the
      // global unhandledRejection handler below, which logs and swallows it -
      // the process stays alive with no window and no visible sign anything
      // went wrong. This turns that silent hang into a loud, diagnosable exit.
      const message = (err as Error).stack ?? String(err)
      try {
        logger.error('Fatal startup error', { error: message })
      } catch {
        // Logger may not be ready yet depending on where startup failed
      }
      dialog.showErrorBox('PackingRecorder failed to start', message)
      app.exit(1)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    logger.info('Application shutting down')
    stationManager.shutdown()
    apiQueueService.stop()
    database.close()
  })

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack })
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) })
  })
}

function applyAutoStartSetting(): void {
  const enabled = configManager.get().autoStartWindows
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
}
