import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  AppConfig,
  RecordingRecord,
  SearchFilters,
  StationRuntimeState,
  WrongBarcodeEvent,
  DuplicateBarcodeEvent,
  CameraDevice,
  ScannerDevice,
  SystemStatusInfo,
  LogEntry,
  SaveLocationStatus,
  UpdateState,
  DiagnosticsSnapshot,
  DiagnosticsTestResult,
  StationValidationIssue,
  DeleteRecordingResult,
  CameraCapabilityOption,
  ApiQueueStatus,
  WarehouseApiConfig,
  WarehouseApiTestResult,
  PlaybackPreflightResult,
  CaptureBeginPayload,
  CaptureEndPayload,
  CaptureChunkPayload,
  CaptureErrorPayload
} from '@shared/types'

const api = {
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),
    update: (partial: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke(IPC.configUpdate, partial),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.configPickFolder),
    validateSaveLocation: (targetPath: string): Promise<SaveLocationStatus> =>
      ipcRenderer.invoke(IPC.configValidateSaveLocation, targetPath),
    createFolder: (targetPath: string): Promise<{ success: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC.configCreateFolder, targetPath),
    resetSaveLocation: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configResetSaveLocation),
    getSaveLocationStatus: (): Promise<SaveLocationStatus | null> =>
      ipcRenderer.invoke(IPC.configGetSaveLocationStatus),
    onSaveLocationStatus: (cb: (status: SaveLocationStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: SaveLocationStatus): void => cb(status)
      ipcRenderer.on(IPC.configOnSaveLocationStatus, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.configOnSaveLocationStatus, listener)
      }
    }
  },
  stations: {
    getState: (): Promise<StationRuntimeState[]> => ipcRenderer.invoke(IPC.stationsGetState),
    setActive: (stationId: string): Promise<void> => ipcRenderer.invoke(IPC.stationsSetActive, stationId),
    onStateChanged: (cb: (state: StationRuntimeState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: StationRuntimeState): void => cb(state)
      ipcRenderer.on(IPC.stationOnStateChanged, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.stationOnStateChanged, listener)
      }
    },
    onWrongBarcode: (cb: (event: WrongBarcodeEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: WrongBarcodeEvent): void => cb(event)
      ipcRenderer.on(IPC.stationOnWrongBarcode, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.stationOnWrongBarcode, listener)
      }
    },
    onDuplicateBarcode: (cb: (event: DuplicateBarcodeEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: DuplicateBarcodeEvent): void => cb(event)
      ipcRenderer.on(IPC.stationOnDuplicateBarcode, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.stationOnDuplicateBarcode, listener)
      }
    },
    getValidation: (): Promise<StationValidationIssue[]> => ipcRenderer.invoke(IPC.stationsGetValidation),
    onValidationChanged: (cb: (issues: StationValidationIssue[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, issues: StationValidationIssue[]): void => cb(issues)
      ipcRenderer.on(IPC.stationOnValidationChanged, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.stationOnValidationChanged, listener)
      }
    }
  },
  barcode: {
    scan: (stationId: string, barcode: string, deviceId: string | null = null): Promise<void> =>
      ipcRenderer.invoke(IPC.barcodeScan, stationId, barcode, deviceId),
    openExistingFolder: (folderPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.barcodeOpenExistingFolder, folderPath)
  },
  cameras: {
    list: (): Promise<{ video: CameraDevice[]; audio: string[] }> => ipcRenderer.invoke(IPC.camerasList),
    onListChanged: (cb: (payload: { video: CameraDevice[]; audio: string[] }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { video: CameraDevice[]; audio: string[] }): void =>
        cb(payload)
      ipcRenderer.on(IPC.cameraOnListChanged, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.cameraOnListChanged, listener)
      }
    },
    getCapabilities: (cameraId: string): Promise<CameraCapabilityOption[]> =>
      ipcRenderer.invoke(IPC.camerasGetCapabilities, cameraId)
  },
  /** The live camera preview is never touched by any of this - it's purely
   *  the chunk pipe from the renderer's own MediaRecorder capture (see
   *  useRecordingCapture.ts) back to the main process. See
   *  CaptureIngestService for the receiving end. */
  capture: {
    onBeginCapture: (cb: (payload: CaptureBeginPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CaptureBeginPayload): void => cb(payload)
      ipcRenderer.on(IPC.recordingBeginCapture, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.recordingBeginCapture, listener)
      }
    },
    onEndCapture: (cb: (payload: CaptureEndPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CaptureEndPayload): void => cb(payload)
      ipcRenderer.on(IPC.recordingEndCapture, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.recordingEndCapture, listener)
      }
    },
    sendChunk: (payload: CaptureChunkPayload): void => {
      ipcRenderer.send(IPC.recordingChunk, payload)
    },
    reportError: (payload: CaptureErrorPayload): void => {
      ipcRenderer.send(IPC.recordingCaptureError, payload)
    }
  },
  diagnostics: {
    get: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke(IPC.diagnosticsGet),
    testRecording: (cameraId: string, micName: string | null): Promise<DiagnosticsTestResult> =>
      ipcRenderer.invoke(IPC.diagnosticsTestRecording, cameraId, micName),
    export: (text: string): Promise<string | null> => ipcRenderer.invoke(IPC.diagnosticsExport, text)
  },
  scanners: {
    list: (): Promise<ScannerDevice[]> => ipcRenderer.invoke(IPC.scannersList),
    onListChanged: (cb: (devices: ScannerDevice[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, devices: ScannerDevice[]): void => cb(devices)
      ipcRenderer.on(IPC.scannersOnListChanged, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.scannersOnListChanged, listener)
      }
    },
    onRawKeydown: (cb: (payload: { deviceId: string | null; timestamp: number }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { deviceId: string | null; timestamp: number }): void =>
        cb(payload)
      ipcRenderer.on(IPC.scannersOnRawKeydown, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.scannersOnRawKeydown, listener)
      }
    }
  },
  recordings: {
    search: (filters: SearchFilters): Promise<RecordingRecord[]> => ipcRenderer.invoke(IPC.recordingsSearch, filters),
    getRecent: (limit: number): Promise<RecordingRecord[]> => ipcRenderer.invoke(IPC.recordingsGetRecent, limit),
    markViewed: (id: number): Promise<void> => ipcRenderer.invoke(IPC.recordingsMarkViewed, id),
    openFolder: (videoPath: string): Promise<void> => ipcRenderer.invoke(IPC.recordingsOpenFolder, videoPath),
    delete: (id: number): Promise<DeleteRecordingResult> => ipcRenderer.invoke(IPC.recordingsDelete, id),
    checkForPlayback: (videoPath: string): Promise<PlaybackPreflightResult> =>
      ipcRenderer.invoke(IPC.recordingsCheckForPlayback, videoPath),
    backupDatabase: (): Promise<string> => ipcRenderer.invoke(IPC.recordingsBackupDatabase)
  },
  system: {
    getStatus: (): Promise<SystemStatusInfo> => ipcRenderer.invoke(IPC.systemGetStatus),
    getLogs: (limit: number): Promise<LogEntry[]> => ipcRenderer.invoke(IPC.systemGetLogs, limit),
    log: (level: LogEntry['level'], message: string, meta?: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke(IPC.systemLogFromRenderer, level, message, meta),
    onLogEntry: (cb: (entry: LogEntry) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, entry: LogEntry): void => cb(entry)
      ipcRenderer.on(IPC.systemOnLogEntry, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.systemOnLogEntry, listener)
      }
    }
  },
  update: {
    check: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheck),
    download: (): Promise<void> => ipcRenderer.invoke(IPC.updateDownload),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
    getState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateGetState),
    onStateChanged: (cb: (state: UpdateState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: UpdateState): void => cb(state)
      ipcRenderer.on(IPC.updateOnStateChanged, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.updateOnStateChanged, listener)
      }
    }
  },
  apiQueue: {
    getStatus: (): Promise<ApiQueueStatus> => ipcRenderer.invoke(IPC.apiQueueGetStatus),
    onStatusChanged: (cb: (status: ApiQueueStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: ApiQueueStatus): void => cb(status)
      ipcRenderer.on(IPC.apiQueueOnStatusChanged, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.apiQueueOnStatusChanged, listener)
      }
    }
  },
  warehouseApi: {
    testConnection: (draft: WarehouseApiConfig): Promise<WarehouseApiTestResult> =>
      ipcRenderer.invoke(IPC.warehouseApiTestConnection, draft)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
