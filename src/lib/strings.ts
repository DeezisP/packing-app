// Centralized Thai UI text. The whole app renders in Thai only (no language
// switcher), so this is a flat dictionary rather than a full i18n framework -
// every component imports from here instead of hardcoding strings, which
// keeps translations consistent and lets the whole vocabulary be reviewed in
// one place.

export const strings = {
  appName: 'PackingRecorder',
  loading: 'กำลังโหลด PackingRecorder...',

  tabs: {
    dashboard: 'แดชบอร์ด',
    search: 'ค้นหา',
    devices: 'จับคู่อุปกรณ์',
    settings: 'ตั้งค่า'
  },

  common: {
    connected: 'เชื่อมต่อแล้ว',
    disconnected: 'ไม่ได้เชื่อมต่อ',
    notAssigned: 'ยังไม่ได้กำหนด',
    notPaired: 'ยังไม่ได้จับคู่',
    none: 'ไม่มี',
    cancel: 'ยกเลิก',
    close: 'ปิด',
    save: 'บันทึก',
    remove: 'ลบ',
    yes: 'ใช่',
    no: 'ไม่ใช่',
    browse: 'เรียกดู...',
    apply: 'ใช้งาน',
    retry: 'ลองอีกครั้ง',
    name: 'ชื่อ',
    status: 'สถานะ'
  },

  dashboard: {
    title: 'สถานีแพ็คสินค้า',
    subtitle: (n: number): string =>
      `รอสแกนบาร์โค้ด... สแกนเนอร์ที่จับคู่แล้วจะส่งไปยังสถานีโดยอัตโนมัติ ส่วนสแกนเนอร์ที่ยังไม่ได้จับคู่จะใช้สถานีที่กำลังใช้งานอยู่ กด 1-${n} เพื่อสลับสถานี`,
    updateAvailable: (v: string): string => `มีอัปเดตใหม่ - v${v}`,
    noEnabledStations: 'ยังไม่มีสถานีที่เปิดใช้งาน ไปที่ ตั้งค่า > สถานีแพ็คสินค้า เพื่อเพิ่มหรือเปิดใช้งานสถานี'
  },

  stationCard: {
    active: (hotkey: number): string => `กำลังใช้งาน (${hotkey})`,
    disabled: 'ปิดใช้งาน',
    camera: 'กล้อง',
    recordingQuality: 'คุณภาพการบันทึก',
    scanner: 'สแกนเนอร์',
    barcode: 'บาร์โค้ด',
    waitingForBarcode: 'รอสแกนบาร์โค้ด...',
    noCameraAssigned: 'ยังไม่ได้กำหนดกล้อง',
    previewUnavailable: (err: string): string => `พรีวิวใช้งานไม่ได้: ${err}`,
    cameraDisconnected: 'กล้องหลุดการเชื่อมต่อ',
    pairedScannerDisconnected:
      'สแกนเนอร์ที่จับคู่ไว้หลุดการเชื่อมต่อ - สถานีนี้ยังใช้งานได้ผ่านตัวเลือกสถานีที่ใช้งานอยู่จนกว่าจะเชื่อมต่อกลับ',
    statusIdle: 'รอดำเนินการ',
    statusRecording: 'กำลังบันทึก',
    statusError: 'ข้อผิดพลาด'
  },

  wrongBarcode: {
    title: 'บาร์โค้ดไม่ถูกต้อง',
    bodyPrefix: 'สแกน',
    bodySuffix: 'แต่สถานีนี้กำลังบันทึกบาร์โค้ด:',
    note: 'การบันทึกยังคงดำเนินต่อไปโดยไม่หยุดชะงัก'
  },

  duplicateBarcode: {
    title: 'มีการบันทึกนี้อยู่แล้ว',
    body: (barcode: string): string => `มีการบันทึกสำหรับบาร์โค้ด ${barcode} อยู่แล้ว จะไม่มีการเขียนทับ`,
    question: 'เปิดโฟลเดอร์หรือไม่?'
  },

  updateModal: {
    readyTitle: 'อัปเดตพร้อมติดตั้งแล้ว',
    availableTitle: 'มีเวอร์ชันใหม่พร้อมใช้งาน',
    version: (v: string): string => `เวอร์ชัน ${v}`,
    later: 'ไว้ทีหลัง'
  },

  updatePanel: {
    currentVersion: 'เวอร์ชันปัจจุบัน',
    latestVersion: 'เวอร์ชันล่าสุด',
    statusIdle: 'ยังไม่ทราบสถานะอัปเดต - คลิกตรวจสอบอัปเดต',
    statusChecking: 'กำลังตรวจสอบอัปเดต...',
    statusAvailable: 'มีเวอร์ชันใหม่พร้อมใช้งาน',
    statusNotAvailable: 'คุณใช้เวอร์ชันล่าสุดอยู่แล้ว',
    statusDownloading: (pct: number): string => `กำลังดาวน์โหลดอัปเดต... ${pct}%`,
    statusDownloaded: 'ดาวน์โหลดอัปเดตเสร็จแล้ว พร้อมติดตั้ง',
    statusErrorFallback: 'ไม่สามารถตรวจสอบอัปเดตได้ โปรดลองอีกครั้งภายหลัง',
    checkForUpdates: 'ตรวจสอบอัปเดต',
    checking: 'กำลังตรวจสอบ...',
    downloadAndInstall: 'ดาวน์โหลดและติดตั้ง',
    restartAndInstall: 'รีสตาร์ทและติดตั้ง',
    restartNote:
      'แอปจะปิดตัวลง อัปเดตในเบื้องหลัง แล้วเปิดขึ้นมาใหม่โดยอัตโนมัติ - ไม่มีหน้าต่างติดตั้งใด ๆ ให้ดำเนินการเพิ่มเติม'
  },

  camera: {
    previewUnavailable: (err: string): string => `พรีวิวใช้งานไม่ได้: ${err}`,
    previewStartingForRecording: 'กำลังเริ่มบันทึก...'
  },

  videoPlayer: {
    meta: (station: string, camera: string, resolution: string, fps: number): string =>
      `${station} · ${camera} · ${resolution} @ ${fps} เฟรม/วินาที`,
    prevFrame: 'เฟรมก่อนหน้า',
    nextFrame: 'เฟรมถัดไป',
    play: 'เล่น',
    pause: 'หยุดชั่วคราว',
    fullscreen: 'เต็มจอ'
  },

  search: {
    title: 'ค้นหาการบันทึก',
    subtitle: 'ดับเบิลคลิกแถวเพื่อเปิดตัวเล่นวิดีโอ',
    barcodePlaceholder: 'บาร์โค้ด',
    allStations: 'ทุกสถานี',
    allCameras: 'ทุกกล้อง',
    colThumbnail: 'ภาพตัวอย่าง',
    colBarcode: 'บาร์โค้ด',
    colStation: 'สถานี',
    colCamera: 'กล้อง',
    colDuration: 'ระยะเวลา',
    colResolution: 'ความละเอียด',
    colFileSize: 'ขนาดไฟล์',
    colStatus: 'สถานะ',
    colCreated: 'สร้างเมื่อ',
    colActions: 'การดำเนินการ',
    noResults: 'ไม่พบการบันทึก',
    statusCompleted: 'เสร็จสมบูรณ์',
    statusRecording: 'กำลังบันทึก',
    statusInterrupted: 'ถูกขัดจังหวะ',
    statusError: 'ข้อผิดพลาด',

    actionPlay: 'เล่น',
    actionOpenFolder: 'เปิดโฟลเดอร์',
    actionDelete: 'ลบ',
    deleting: 'กำลังลบ...',
    deleteSuccess: (barcode: string): string => `ลบการบันทึก ${barcode} เรียบร้อยแล้ว`,
    deleteFailed: (reason: string): string => `ลบไม่สำเร็จ: ${reason}`,
    deleteFailedUnknown: 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ',

    deleteDialogTitle: 'ลบการบันทึก',
    deleteDialogBody: 'คุณแน่ใจหรือไม่ว่าต้องการลบการบันทึกนี้อย่างถาวร?',
    deleteDialogBarcode: (barcode: string): string => `บาร์โค้ด: ${barcode}`,
    deleteDialogWillDelete: 'การดำเนินการนี้จะลบไฟล์ต่อไปนี้อย่างถาวร:',
    deleteDialogAnyRelatedFiles: 'ไฟล์อื่น ๆ ที่เกี่ยวข้อง',
    deleteDialogIrreversible: 'การดำเนินการนี้ไม่สามารถย้อนกลับได้'
  },

  saveLocationBanner: {
    prefix: 'โฟลเดอร์บันทึกใช้งานไม่ได้:',
    fallback: 'ไม่สามารถเขียนไฟล์ลงในโฟลเดอร์ที่ตั้งค่าไว้ได้',
    suffix: 'การบันทึกใหม่จะถูกระงับจนกว่าจะเลือกโฟลเดอร์ที่ใช้งานได้ในหน้าตั้งค่า'
  },

  stationValidation: {
    title: 'พบปัญหาการตั้งค่าสถานี:',
    scannerMissing: (station: string): string =>
      `${station} - ยังไม่ได้จับคู่สแกนเนอร์ (ต้องเลือกสถานีด้วยตนเองเมื่อสแกน)`,
    cameraMissing: (station: string): string => `${station} - ยังไม่ได้กำหนดกล้อง`,
    scannerDuplicate: (station: string): string => `${station} - สแกนเนอร์นี้ถูกกำหนดให้มากกว่าหนึ่งสถานี`,
    cameraDuplicate: (station: string): string => `${station} - กล้องนี้ถูกกำหนดให้มากกว่าหนึ่งสถานี`
  },

  bottomPanel: {
    recentRecordings: 'การบันทึกล่าสุด',
    noRecordingsYet: 'ยังไม่มีการบันทึก',
    diskUsage: 'พื้นที่ดิสก์',
    freeOfTotal: (free: string, total: string): string => `${free} ว่าง จากทั้งหมด ${total}`,
    lowDiskSpace: 'พื้นที่ดิสก์เหลือน้อย',
    systemStatus: 'สถานะระบบ',
    uptime: (v: string): string => `เวลาทำงาน: ${v}`,
    totalRecordings: (v: number): string => `การบันทึกทั้งหมด: ${v}`,
    activeRecordings: (v: number): string => `กำลังบันทึกอยู่: ${v}`
  },

  settings: {
    title: 'ตั้งค่า',
    subtitle: 'การเปลี่ยนแปลงจะถูกบันทึกโดยอัตโนมัติ',
    saving: 'กำลังบันทึก...',
    saved: 'บันทึกแล้ว',

    sectionGeneral: 'ทั่วไป',
    currentSaveLocation: 'โฟลเดอร์บันทึกปัจจุบัน',
    saveLocationPlaceholder: 'เช่น D:\\PackingVideos',
    resetToDefault: 'รีเซ็ตเป็นค่าเริ่มต้น',
    checkingFolder: 'กำลังตรวจสอบโฟลเดอร์...',
    folderNotExist: 'ยังไม่มีโฟลเดอร์นี้',
    folderNotWritable: 'ไม่สามารถเขียนไฟล์ลงในโฟลเดอร์นี้ได้',
    folderWritable: (free: string, total: string): string => `เขียนไฟล์ได้ - ว่าง ${free} จากทั้งหมด ${total} บนไดรฟ์นี้`,
    unsavedPath: 'เส้นทางยังไม่ถูกบันทึก - คลิกใช้งาน (หรือกด Enter) เพื่อใช้เส้นทางนี้',
    theme: 'ธีม',
    themeDark: 'มืด',
    themeLight: 'สว่าง',
    autoStart: 'เริ่มทำงานพร้อม Windows โดยอัตโนมัติ',
    autoBackup: 'สำรองฐานข้อมูลอัตโนมัติ',
    backupNow: 'สำรองข้อมูลตอนนี้',
    backupCreated: (path: string): string => `สร้างไฟล์สำรองแล้ว: ${path}`,

    sectionUpdates: 'อัปเดต',

    sectionStations: 'สถานีแพ็คสินค้า',
    addStation: '+ เพิ่มสถานี',
    stationNumber: (n: number): string => `สถานี ${n}`,
    enableStation: 'เปิดใช้งานสถานีนี้',
    moveUp: 'เลื่อนขึ้น',
    moveDown: 'เลื่อนลง',
    microphone: 'ไมโครโฟน',
    micNone: 'ไม่มี (บันทึกเฉพาะวิดีโอ)',
    qualityPreset: 'คุณภาพการบันทึก',
    qualityPresetUnsupportedSuffix: 'กล้องไม่รองรับ',
    qualityPresetUnsupportedWarning: (preset: string): string =>
      `กล้องที่กำหนดให้สถานีนี้ไม่รองรับคุณภาพ "${preset}" - เลือกคุณภาพอื่นที่กล้องรองรับ ระบบจะไม่เปลี่ยนความละเอียดให้อัตโนมัติ`,
    saveLocationOverride: 'โฟลเดอร์บันทึกของสถานีนี้',
    useGlobalSaveLocation: 'ใช้โฟลเดอร์บันทึกส่วนกลาง',
    customSaveLocationPlaceholder: 'เช่น D:\\StationVideos',

    sectionOverlay: 'ข้อความซ้อนทับวิดีโอ',
    enableOverlay: 'เปิดใช้งานข้อความซ้อนทับ',
    showBarcode: 'แสดงบาร์โค้ด',
    showDate: 'แสดงวันที่',
    showTime: 'แสดงเวลาปัจจุบัน',
    showTimer: 'แสดงตัวจับเวลาบันทึก',
    showStation: 'แสดงสถานีแพ็คสินค้า',
    showCamera: 'แสดงชื่อกล้อง',
    overlayPosition: 'ตำแหน่งข้อความซ้อนทับ',
    posTopLeft: 'บนซ้าย',
    posTopRight: 'บนขวา',
    posBottomLeft: 'ล่างซ้าย',
    posBottomRight: 'ล่างขวา',
    fontSize: 'ขนาดตัวอักษร',
    backgroundOpacity: 'ความทึบพื้นหลัง',
    fontColor: 'สีตัวอักษร',
    backgroundColor: 'สีพื้นหลัง',
    livePreview: 'พรีวิวสด',

    sectionScannerAssignment: 'การจับคู่สแกนเนอร์',
    scannerAssignmentBody: (n: number): string =>
      `จับคู่สแกนเนอร์กับสถานีได้จากแท็บ "จับคู่อุปกรณ์" ซึ่งจะระบุสแกนเนอร์ USB แต่ละตัวโดยอัตโนมัติ (ผ่าน Windows Raw Input) และให้เลือกกำหนดได้ผ่านเมนู รวมถึงปุ่มระบุสแกนเนอร์สำหรับกรณีที่มีสแกนเนอร์รุ่นเดียวกันหลายตัว เมื่อจับคู่แล้ว การสแกนจากสแกนเนอร์นั้นจะส่งไปยังสถานีที่กำหนดโดยอัตโนมัติ สถานีที่ไม่มีสแกนเนอร์จับคู่จะยังใช้ตัวเลือกสถานีที่ใช้งานอยู่บนแดชบอร์ดได้ (คลิกที่การ์ด หรือกด 1-${n})`,

    folderDoesNotExistTitle: 'ยังไม่มีโฟลเดอร์นี้',
    folderDoesNotExistBody: (path: string): string => `${path} ยังไม่มีอยู่ ต้องการสร้างหรือไม่?`,
    createIt: 'ใช่ สร้างโฟลเดอร์นี้',

    sectionApiIntegration: 'การเชื่อมต่อ API คลังสินค้า',
    apiIntegrationBody:
      'ส่งข้อมูลบาร์โค้ดที่สแกนไปยังระบบคลังสินค้าภายนอกโดยอัตโนมัติผ่านคิวสำรอง - หากเชื่อมต่อไม่ได้ชั่วคราว ระบบจะลองส่งใหม่โดยอัตโนมัติในภายหลังโดยไม่กระทบการบันทึกวิดีโอ',
    apiEnable: 'เปิดใช้งาน',
    apiBaseUrl: 'URL ของ API',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'วาง API Key ที่นี่',
    apiKeyShow: 'แสดง',
    apiKeyHide: 'ซ่อน',
    apiScannerUser: 'ชื่อผู้ใช้สแกนเนอร์ (scannerUser)',
    apiScannerUserPlaceholder: 'เช่น somchai',
    apiQueuePending: (n: number): string => `รอส่งในคิว: ${n} รายการ`,
    apiQueueLastError: (err: string): string => `ข้อผิดพลาดล่าสุด: ${err}`,
    apiQueueLastSuccess: (t: string): string => `ส่งสำเร็จล่าสุด: ${t}`
  },

  devicePairing: {
    title: 'จับคู่อุปกรณ์',
    subtitle:
      'ระบุสแกนเนอร์บาร์โค้ดแต่ละตัว ตั้งชื่อ แล้วกำหนดให้กับสถานี เมื่อจับคู่แล้ว การสแกนจากสแกนเนอร์นั้นจะส่งไปยังสถานีโดยอัตโนมัติ',
    identifyScanner: '+ ระบุสแกนเนอร์',
    scanningNow: 'กำลังรอสแกน...',
    waitingBanner: 'สแกนบาร์โค้ดใด ๆ บนสแกนเนอร์ที่ต้องการระบุ กำลังรอ...',
    identifyTimeout: 'ไม่พบการสแกนภายใน 15 วินาที ลองอีกครั้ง',
    rawInputUnavailable: 'ไม่สามารถระบุได้ว่าสแกนนั้นมาจากสแกนเนอร์ตัวใด ระบบอาจไม่รองรับ Raw Input บนเครื่องนี้',
    renamePrompt: 'ระบบจดจำสแกนเนอร์นี้ได้แล้ว อัปเดตชื่อ:',
    newScannerPrompt: 'พบสแกนเนอร์ใหม่! ตั้งชื่อ:',
    namePlaceholder: 'เช่น โต๊ะแพ็ค 1',
    emptyState: 'ยังไม่มีสแกนเนอร์ที่ระบุ คลิก "ระบุสแกนเนอร์" ด้านบน แล้วสแกนบาร์โค้ดใด ๆ บนสแกนเนอร์ที่ต้องการเพิ่ม',
    scannerLabel: 'สแกนเนอร์',
    station: 'สถานี',
    camera: (name: string): string => `กล้อง: ${name}`,
    advanced: 'ขั้นสูง',
    instanceId: (id: string): string => `รหัสอุปกรณ์: ${id}`,
    sectionCameras: 'กล้อง',
    testCamera: 'ทดสอบกล้อง',
    noCamerasDetected: 'ไม่พบกล้อง'
  },

  diagnostics: {
    sectionTitle: 'การวินิจฉัย',
    intro:
      'เปรียบเทียบผลการตรวจจับกล้องจาก Chromium, FFmpeg และ Windows แยกกัน เพื่อยืนยันว่ากล้องรุ่นเดียวกันหลายตัวถูกแยกออกจากกันอย่างถูกต้องในทุกขั้นตอน ตั้งแต่ตรวจจับอุปกรณ์ไปจนถึงบันทึกวิดีโอ',
    refresh: 'รีเฟรช',
    refreshing: 'กำลังตรวจสอบ...',
    detectedByChromium: (n: number): string => `ตรวจพบโดย Chromium (${n})`,
    detectedByFfmpeg: (n: number): string => `ตรวจพบโดย FFmpeg / DirectShow (${n})`,
    detectedByWindows: (n: number): string => `ตรวจพบโดย Windows (${n})`,
    unlabeledDevice: '(ยังไม่ได้รับอนุญาตให้เข้าถึงกล้อง)',
    previewBackendLabel: 'Backend สำหรับพรีวิว:',
    previewBackendValue: 'Chromium MediaDevices (getUserMedia)',
    recordingBackendLabel: 'Backend สำหรับบันทึก:',
    recordingBackendValue: 'FFmpeg / DirectShow',
    generatedFfmpegCommand: 'คำสั่ง FFmpeg ที่ใช้จริง',
    stationAssignments: 'รหัสเฉพาะภายในและการกำหนดให้สถานี',
    internalId: 'รหัสเฉพาะภายใน',
    ffmpegDeviceId: 'รหัสอุปกรณ์ FFmpeg',
    windowsInstanceId: 'รหัสอุปกรณ์ Windows',
    windowsStatus: 'สถานะ',
    noneDetected: 'ยังไม่พบอุปกรณ์',
    cameraAssignedTo: (station: string): string => `กำหนดให้ ${station}`,
    cameraUnassigned: 'ยังไม่ได้กำหนดให้สถานีใด',
    recordingTest: 'ทดสอบการบันทึก',
    testing: 'กำลังทดสอบ...',
    testPassed: 'ทดสอบผ่าน - บันทึกได้สำเร็จ',
    testFailed: (err: string): string => `ทดสอบไม่ผ่าน - ${err}`,
    exportButton: 'ส่งออกไฟล์วินิจฉัย',
    exporting: 'กำลังส่งออก...',
    exportedTo: (path: string): string => `บันทึกไฟล์วินิจฉัยแล้วที่ ${path}`,
    exportCancelled: 'ยกเลิกการส่งออก',
    showRaw: 'แสดงผลลัพธ์ดิบจาก FFmpeg',
    hideRaw: 'ซ่อนผลลัพธ์ดิบจาก FFmpeg'
  }
}
