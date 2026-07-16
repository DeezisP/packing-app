import { app, BrowserWindow, Menu } from 'electron'
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
import { recordingEngine } from './services/RecordingEngine'
import { updateService } from './services/UpdateService'
import { apiQueueService } from './services/ApiQueueService'

const AUTO_UPDATE_CHECK_DELAY_MS = 8000

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
    electronApp.setAppUserModelId('com.packingrecorder.app')

    configManager.ensureDirectories()
    logger.init()
    logger.info('Application starting', { version: app.getVersion(), packaged: app.isPackaged })

    await database.init()
    const recovered = database.recoverOrphanedRecordings()
    if (recovered > 0) {
      logger.warn('Previous session ended unexpectedly, recordings marked interrupted', { count: recovered })
    }

    applyAutoStartSetting()
    configManager.on('changed', applyAutoStartSetting)

    stationManager.init()
    cameraManager.startPolling()
    scannerManager.startPolling()
    apiQueueService.start()
    registerMediaProtocol()
    registerIpcHandlers()

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

    const mainWindow = createMainWindow()
    // Raw Input registration needs a real native window handle, so this can
    // only happen after the window exists - unlike the other services above.
    rawInputService.init(mainWindow)

    app.on('browser-window-created', (_e, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    logger.info('Application shutting down')
    stationManager.shutdown()
    recordingEngine.killAll()
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
