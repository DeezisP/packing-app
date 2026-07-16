// Central registry of IPC channel names shared by main, preload and renderer.
export const IPC = {
  // Config
  configGet: 'config:get',
  configUpdate: 'config:update',
  configPickFolder: 'config:pickFolder',
  configValidateSaveLocation: 'config:validateSaveLocation',
  configCreateFolder: 'config:createFolder',
  configResetSaveLocation: 'config:resetSaveLocation',
  configGetSaveLocationStatus: 'config:getSaveLocationStatus',
  configOnSaveLocationStatus: 'config:onSaveLocationStatus',

  // Stations / runtime
  stationsGetState: 'stations:getState',
  stationsSetActive: 'stations:setActive',
  stationOnStateChanged: 'stations:onStateChanged',
  stationOnWrongBarcode: 'stations:onWrongBarcode',
  stationOnDuplicateBarcode: 'stations:onDuplicateBarcode',

  // Barcode
  barcodeScan: 'barcode:scan',
  barcodeOpenExistingFolder: 'barcode:openExistingFolder',

  // Cameras
  camerasList: 'cameras:list',
  cameraOnListChanged: 'cameras:onListChanged',

  // Diagnostics
  diagnosticsGet: 'diagnostics:get',
  diagnosticsTestRecording: 'diagnostics:testRecording',
  diagnosticsExport: 'diagnostics:export',

  // Scanners / device pairing
  scannersList: 'scanners:list',
  scannersOnListChanged: 'scanners:onListChanged',
  scannersOnRawKeydown: 'scanners:onRawKeydown',

  // Database / recordings
  recordingsSearch: 'recordings:search',
  recordingsGetRecent: 'recordings:getRecent',
  recordingsMarkViewed: 'recordings:markViewed',
  recordingsOpenFolder: 'recordings:openFolder',
  recordingsBackupDatabase: 'recordings:backupDatabase',

  // System
  systemGetStatus: 'system:getStatus',
  systemGetLogs: 'system:getLogs',
  systemOnLogEntry: 'system:onLogEntry',
  systemLogFromRenderer: 'system:logFromRenderer',

  // Updates (electron-updater / GitHub Releases)
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateGetState: 'update:getState',
  updateOnStateChanged: 'update:onStateChanged'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
