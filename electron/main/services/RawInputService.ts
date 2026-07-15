import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { logger } from './Logger'
import { normalizeInstanceId } from './ScannerManager'

const WM_INPUT = 0x00ff
const RID_INPUT = 0x10000003
const RIDEV_INPUTSINK = 0x00000100
const RIM_TYPEKEYBOARD = 1
const RIDI_DEVICENAME = 0x20000007
const RAWINPUTHEADER_SIZE = 24 // dwType(4) + dwSize(4) + hDevice(8) + wParam(8), x64

/** Distinguishes which *physical* USB HID device sent a given keystroke -
 *  something no Electron/Chromium API exposes on its own, since keyboard
 *  events reaching the renderer have already lost their originating device.
 *  Uses Windows Raw Input (WM_INPUT) via Electron's hookWindowMessage plus a
 *  handful of user32.dll calls through koffi (a prebuilt-binary FFI library,
 *  so this needs no native compilation/Visual Studio Build Tools).
 *
 *  This only ever *supplements* barcode capture - if Raw Input fails to
 *  initialize for any reason (locked-down environment, missing DLL, etc.)
 *  the app keeps working exactly as before via the active-station selector;
 *  nothing here is on the critical path for recording to function. */
class RawInputService extends EventEmitter {
  private available = false
  private deviceIdCache = new Map<bigint, string | null>()
  private getRawInputData: ((...args: unknown[]) => number) | null = null
  private getRawInputDeviceInfoW: ((...args: unknown[]) => number) | null = null

  init(win: BrowserWindow): void {
    if (process.platform !== 'win32') {
      logger.info('Raw Input scanner identification skipped (non-Windows platform)')
      return
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi') as typeof import('koffi')
      const user32 = koffi.load('user32.dll')

      const RAWINPUTDEVICE = koffi.struct('RAWINPUTDEVICE', {
        usUsagePage: 'uint16',
        usUsage: 'uint16',
        dwFlags: 'uint32',
        hwndTarget: 'void *'
      })

      const registerRawInputDevices = user32.func('__stdcall', 'RegisterRawInputDevices', 'bool', [
        koffi.pointer(RAWINPUTDEVICE),
        'uint32',
        'uint32'
      ])

      const getRawInputData = user32.func('__stdcall', 'GetRawInputData', 'int32', [
        'void *',
        'uint32',
        'void *',
        koffi.pointer('uint32'),
        'uint32'
      ])

      const getRawInputDeviceInfoW = user32.func('__stdcall', 'GetRawInputDeviceInfoW', 'int32', [
        'void *',
        'uint32',
        'void *',
        koffi.pointer('uint32')
      ])

      this.getRawInputData = getRawInputData as unknown as (...args: unknown[]) => number
      this.getRawInputDeviceInfoW = getRawInputDeviceInfoW as unknown as (...args: unknown[]) => number

      const hwndPtr = win.getNativeWindowHandle().readBigUInt64LE(0)
      const registered = registerRawInputDevices(
        [{ usUsagePage: 0x01, usUsage: 0x06, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwndPtr }],
        1,
        koffi.sizeof(RAWINPUTDEVICE)
      )

      if (!registered) {
        logger.warn('RegisterRawInputDevices failed - per-scanner identification will not be available')
        return
      }

      win.hookWindowMessage(WM_INPUT, (_wParam, lParam) => {
        this.handleRawInput(lParam as Buffer)
      })

      this.available = true
      logger.info('Raw Input scanner identification initialized')
    } catch (err) {
      logger.warn('Raw Input initialization failed - falling back to active-station selection only', {
        error: (err as Error).message
      })
      this.available = false
    }
  }

  isAvailable(): boolean {
    return this.available
  }

  private handleRawInput(lParam: Buffer): void {
    if (!this.getRawInputData) return
    try {
      const lParamPtr = lParam.readBigUInt64LE(0)
      const sizeBuf = Buffer.alloc(4)
      this.getRawInputData(lParamPtr, RID_INPUT, null, sizeBuf, RAWINPUTHEADER_SIZE)
      const size = sizeBuf.readUInt32LE(0)
      if (size === 0 || size > 4096) return

      const dataBuf = Buffer.alloc(size)
      const ret = this.getRawInputData(lParamPtr, RID_INPUT, dataBuf, sizeBuf, RAWINPUTHEADER_SIZE)
      if (ret !== size) return

      const dwType = dataBuf.readUInt32LE(0)
      if (dwType !== RIM_TYPEKEYBOARD) return

      const hDevice = dataBuf.readBigUInt64LE(8)
      // hDevice is NULL for synthetically injected input (e.g. remote desktop,
      // SendInput-based tools) - there's no real physical device to identify.
      if (hDevice === 0n) return

      const deviceId = this.resolveDeviceId(hDevice)
      this.emit('keydown', { deviceId, timestamp: Date.now() })
    } catch (err) {
      logger.error('Raw input decode failed', { error: (err as Error).message })
    }
  }

  private resolveDeviceId(hDevice: bigint): string | null {
    if (this.deviceIdCache.has(hDevice)) {
      return this.deviceIdCache.get(hDevice) ?? null
    }
    const deviceId = this.queryDeviceName(hDevice)
    this.deviceIdCache.set(hDevice, deviceId)
    return deviceId
  }

  private queryDeviceName(hDevice: bigint): string | null {
    if (!this.getRawInputDeviceInfoW) return null
    try {
      const sizeBuf = Buffer.alloc(4)
      this.getRawInputDeviceInfoW(hDevice, RIDI_DEVICENAME, null, sizeBuf)
      const charCount = sizeBuf.readUInt32LE(0)
      if (charCount === 0) return null

      const dataBuf = Buffer.alloc(charCount * 2)
      const ret = this.getRawInputDeviceInfoW(hDevice, RIDI_DEVICENAME, dataBuf, sizeBuf)
      if (ret < 0) return null

      const raw = dataBuf.toString('utf16le')
      const trimmed = stripTrailingNulChar(raw)
      return rawDevicePathToInstanceId(trimmed)
    } catch (err) {
      logger.error('GetRawInputDeviceInfoW failed', { error: (err as Error).message })
      return null
    }
  }

}

/** Windows returns fixed-length wide-char buffers padded with the NUL
 *  character - trim everything from the first NUL onward using char codes
 *  rather than a literal escape, to avoid any editor/encoding ambiguity. */
function stripTrailingNulChar(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 0) {
      return value.slice(0, i)
    }
  }
  return value
}

/** Converts a Raw Input device path like
 *  "\\?\HID#VID_1234&PID_5678&MI_00#7&abc123&0&0000#{class-guid}"
 *  into the same normalized form ScannerManager derives from PnP InstanceIds
 *  ("HID\VID_1234&PID_5678&MI_00\7&ABC123&0&0000"), so the two can be
 *  compared directly. */
export function rawDevicePathToInstanceId(devicePath: string): string {
  let p = devicePath.replace(/^\\\\\?\\/, '')
  p = p.replace(/#\{[0-9a-f-]+\}$/i, '')
  p = p.split('#').join('\\')
  return normalizeInstanceId(p)
}

export const rawInputService = new RawInputService()
