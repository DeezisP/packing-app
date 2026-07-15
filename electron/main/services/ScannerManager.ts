import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { logger } from './Logger'
import type { ScannerDevice } from '@shared/types'

const POLL_INTERVAL_MS = 5000

interface PnpDeviceRaw {
  FriendlyName?: string
  InstanceId?: string
  Status?: string
}

/** Enumerates USB barcode scanners (which register with Windows as HID
 *  keyboard-class devices) via PowerShell's Get-PnpDevice, giving each one a
 *  stable Instance ID and friendly name without any native dependency.
 *  This is enumeration only (name/ID/status) - telling *which* connected
 *  scanner sent a given keystroke requires RawInputService instead. */
class ScannerManager extends EventEmitter {
  private lastDevices: ScannerDevice[] = []
  private pollTimer: NodeJS.Timeout | null = null

  private runPnpQuery(): Promise<ScannerDevice[]> {
    return new Promise((resolve) => {
      // Windows classifies actual keyboard-input-capable devices under the
      // "Keyboard" PnP class - including keyboard-emulating barcode scanners,
      // since that's how they inject "typed" barcode data. Deliberately NOT
      // querying the generic "HIDClass" too: that catch-all also matches
      // headsets, mice, webcam HID controls, and vendor-defined HID
      // interfaces, which would flood this list with irrelevant devices.
      // Filtering to InstanceIds starting with HID\ excludes built-in/PS2
      // keyboards (which enumerate under ACPI\ or similar), leaving only USB
      // HID keyboard-class devices.
      const script =
        "Get-PnpDevice -Class Keyboard -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.InstanceId -like 'HID\\*' } | " +
        'Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json -Compress'

      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        logger.error('Failed to spawn PowerShell for scanner enumeration', { error: err.message })
        resolve([])
      })
      child.on('close', () => {
        if (!stdout.trim()) {
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(stdout) as PnpDeviceRaw | PnpDeviceRaw[]
          const list = Array.isArray(parsed) ? parsed : [parsed]
          resolve(
            list
              .filter((d) => d.InstanceId)
              .map((d) => ({
                id: normalizeInstanceId(d.InstanceId as string),
                name: d.FriendlyName || 'USB HID Keyboard Device',
                connected: d.Status === 'OK'
              }))
          )
        } catch (err) {
          logger.error('Failed to parse scanner enumeration output', {
            error: (err as Error).message,
            stderr: stderr.slice(0, 500)
          })
          resolve([])
        }
      })
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 8000)
    })
  }

  async listScanners(): Promise<ScannerDevice[]> {
    const devices = await this.runPnpQuery()
    this.lastDevices = devices
    return devices
  }

  getLastKnownDevices(): ScannerDevice[] {
    return this.lastDevices
  }

  isConnected(id: string | null): boolean {
    if (!id) return false
    return this.lastDevices.some((d) => d.id === id && d.connected)
  }

  async refresh(): Promise<ScannerDevice[]> {
    const devices = await this.runPnpQuery()
    const changed = JSON.stringify(devices) !== JSON.stringify(this.lastDevices)
    this.lastDevices = devices
    if (changed) {
      this.emit('changed', devices)
    }
    return devices
  }

  startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      this.refresh().catch((err) => logger.error('Scanner polling failed', { error: (err as Error).message }))
    }, POLL_INTERVAL_MS)
    this.refresh().catch((err) => logger.error('Initial scanner scan failed', { error: (err as Error).message }))
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}

/** Normalizes a PnP InstanceId (e.g. "HID\VID_1234&PID_5678&MI_00\7&abc&0&0000")
 *  to a consistent uppercase form so it can be compared reliably against the
 *  IDs RawInputService derives from raw device paths. */
export function normalizeInstanceId(instanceId: string): string {
  return instanceId.trim().toUpperCase()
}

export const scannerManager = new ScannerManager()
