import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import { configManager } from '../services/ConfigManager'
import { database } from '../services/Database'
import { cameraManager } from '../services/CameraManager'
import { scannerManager } from '../services/ScannerManager'
import { rawInputService } from '../services/RawInputService'
import { stationManager } from '../services/StationManager'
import { recordingEngine } from '../services/RecordingEngine'
import { updateService } from '../services/UpdateService'
import { logger } from '../services/Logger'
import { getDiskUsage } from '../services/DiskMonitor'
import { validateSaveLocation, createSaveLocationFolder } from '../services/SaveLocationValidator'
import { defaultPaths, resolveSaveLocation } from '../services/PathService'
import { resolveFfmpegPath } from '../services/FfmpegLocator'
import { listWindowsCameras } from '../services/WindowsDeviceService'
import type { AppConfig, SearchFilters, DiagnosticsStationAssignment, LogEntry } from '@shared/types'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.configGet, () => configManager.get())

  ipcMain.handle(IPC.configUpdate, (_e, partial: Partial<AppConfig>) => configManager.update(partial))

  ipcMain.handle(IPC.configPickFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.configValidateSaveLocation, async (_e, targetPath: string) => {
    const resolved = resolveSaveLocation(targetPath)
    return validateSaveLocation(resolved)
  })

  ipcMain.handle(IPC.configCreateFolder, async (_e, targetPath: string) => {
    const resolved = resolveSaveLocation(targetPath)
    try {
      createSaveLocationFolder(resolved)
      logger.info('Created save location folder', { path: resolved })
      return { success: true, error: null }
    } catch (err) {
      const message = (err as Error).message
      logger.error('Failed to create save location folder', { path: resolved, error: message })
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IPC.configResetSaveLocation, () => {
    return configManager.update({ saveLocation: configManager.getDefaultSaveLocation() })
  })

  ipcMain.handle(IPC.configGetSaveLocationStatus, () => stationManager.getSaveLocationStatus())

  ipcMain.handle(IPC.stationsGetState, () => stationManager.getAllStates())

  ipcMain.handle(IPC.stationsSetActive, (_e, stationId: string) => {
    configManager.update({ activeStationId: stationId })
  })

  ipcMain.handle(IPC.stationsGetValidation, () => stationManager.getValidationIssues())

  ipcMain.handle(IPC.barcodeScan, async (_e, stationId: string, barcode: string, deviceId: string | null) => {
    await stationManager.handleScan(stationId, barcode.trim(), deviceId ?? null)
  })

  ipcMain.handle(IPC.barcodeOpenExistingFolder, (_e, folderPath: string) => {
    shell.openPath(folderPath)
  })

  ipcMain.handle(IPC.camerasList, async () => {
    const [video, audio] = await Promise.all([cameraManager.listVideoDevices(), cameraManager.listAudioDevices()])
    return { video, audio }
  })

  // Gathers every independent camera-detection source (ffmpeg/DirectShow,
  // Windows PnP) plus current station assignments and recent logs in one
  // call, for Settings -> Diagnostics. Chromium's own device list can only
  // be read by the renderer (navigator.mediaDevices), so it's merged in
  // there rather than here.
  ipcMain.handle(IPC.diagnosticsGet, async () => {
    const [video, audio] = await Promise.all([cameraManager.listVideoDevices(), cameraManager.listAudioDevices()])
    const windows = await listWindowsCameras()
    const stations: DiagnosticsStationAssignment[] = configManager.get().stations.map((station) => {
      const resolved = cameraManager.resolveStationCamera(station)
      return {
        stationId: station.id,
        stationName: station.name,
        cameraId: station.cameraId,
        cameraName: station.cameraName,
        resolvedCameraId: resolved?.id ?? null,
        connected: Boolean(resolved)
      }
    })
    return {
      ffmpeg: { raw: cameraManager.getLastRawOutput(), video, audio },
      windows,
      stations,
      recentLogs: logger.getRecentEntries(300),
      appVersion: app.getVersion(),
      ffmpegPath: resolveFfmpegPath()
    }
  })

  ipcMain.handle(IPC.diagnosticsTestRecording, (_e, cameraId: string, micName: string | null) =>
    recordingEngine.testRecording(cameraId, micName)
  )

  ipcMain.handle(IPC.diagnosticsExport, async (_e, text: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: 'diagnostics.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, text, 'utf-8')
    logger.info('Diagnostics exported', { path: result.filePath })
    return result.filePath
  })

  ipcMain.handle(IPC.scannersList, () => scannerManager.listScanners())

  ipcMain.handle(IPC.recordingsSearch, (_e, filters: SearchFilters) => database.search(filters))

  ipcMain.handle(IPC.recordingsGetRecent, (_e, limit: number) => database.getRecent(limit ?? 20))

  ipcMain.handle(IPC.recordingsMarkViewed, (_e, id: number) => database.markViewed(id))

  ipcMain.handle(IPC.recordingsOpenFolder, (_e, videoPath: string) => {
    shell.showItemInFolder(videoPath)
  })

  ipcMain.handle(IPC.recordingsBackupDatabase, async () => {
    const backupDir = path.join(path.dirname(defaultPaths.databaseFile), 'Backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const dest = path.join(backupDir, `database-${Date.now()}.sqlite`)
    database.backup(dest)
    logger.info('Manual database backup triggered', { dest })
    return dest
  })

  ipcMain.handle(IPC.systemGetStatus, async () => {
    const disk = await getDiskUsage(configManager.getResolvedSaveLocation())
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      totalRecordings: database.countAll(),
      activeRecordings: database.countActive(),
      disk
    }
  })

  ipcMain.handle(IPC.systemGetLogs, (_e, limit: number) => logger.getRecentEntries(limit ?? 200))

  // Lets the renderer write into the same app.log the main process uses, so
  // UI/preview-stage events (a preview attach attempt, a picker interaction)
  // show up interleaved with enumeration/recording events instead of being
  // invisible to log-based diagnostics.
  ipcMain.handle(
    IPC.systemLogFromRenderer,
    (_e, level: LogEntry['level'], message: string, meta?: Record<string, unknown>) => {
      logger[level](`[renderer] ${message}`, meta)
    }
  )

  ipcMain.handle(IPC.updateCheck, () => updateService.check())
  ipcMain.handle(IPC.updateDownload, () => updateService.download())
  ipcMain.handle(IPC.updateInstall, () => updateService.quitAndInstall())
  ipcMain.handle(IPC.updateGetState, () => updateService.getState())

  // Forward internal service events to every renderer window.
  stationManager.on('stateChanged', (state) => broadcast(IPC.stationOnStateChanged, state))
  stationManager.on('wrongBarcode', (event) => broadcast(IPC.stationOnWrongBarcode, event))
  stationManager.on('duplicateBarcode', (event) => broadcast(IPC.stationOnDuplicateBarcode, event))
  stationManager.on('saveLocationStatus', (status) => broadcast(IPC.configOnSaveLocationStatus, status))
  stationManager.on('validationChanged', (issues) => broadcast(IPC.stationOnValidationChanged, issues))
  cameraManager.on('changed', (payload) => broadcast(IPC.cameraOnListChanged, payload))
  scannerManager.on('changed', (devices) => broadcast(IPC.scannersOnListChanged, devices))
  rawInputService.on('keydown', (payload) => broadcast(IPC.scannersOnRawKeydown, payload))
  logger.on('entry', (entry) => broadcast(IPC.systemOnLogEntry, entry))
  updateService.on('stateChanged', (state) => broadcast(IPC.updateOnStateChanged, state))
}
