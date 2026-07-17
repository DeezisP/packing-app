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
  stationsGetValidation: 'stations:getValidation',
  stationOnValidationChanged: 'stations:onValidationChanged',

  // Barcode
  barcodeScan: 'barcode:scan',
  barcodeOpenExistingFolder: 'barcode:openExistingFolder',

  // Cameras
  camerasList: 'cameras:list',
  cameraOnListChanged: 'cameras:onListChanged',
  camerasGetCapabilities: 'cameras:getCapabilities',
  camerasGetOwner: 'cameras:getOwner',
  cameraReportPreviewOwnership: 'cameras:reportPreviewOwnership',
  cameraOnReleaseForRecording: 'cameras:onReleaseForRecording',
  cameraOnReacquireAfterRecording: 'cameras:onReacquireAfterRecording',
  cameraOnPreviewFrame: 'cameras:onPreviewFrame',

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
  recordingsDelete: 'recordings:delete',
  recordingsBackupDatabase: 'recordings:backupDatabase',
  recordingsCheckForPlayback: 'recordings:checkForPlayback',

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
  updateOnStateChanged: 'update:onStateChanged',

  // External warehouse API scan queue
  apiQueueGetStatus: 'apiQueue:getStatus',
  apiQueueOnStatusChanged: 'apiQueue:onStatusChanged',
  warehouseApiTestConnection: 'warehouseApi:testConnection'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
