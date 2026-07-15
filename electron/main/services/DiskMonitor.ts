import checkDiskSpaceImport from 'check-disk-space'
import type { DiskUsageInfo } from '@shared/types'

// electron-vite externalizes this dep into a raw require() call, which does
// not always unwrap a TS-style `exports.default`. Handle both shapes so this
// works the same whether or not that interop unwrapping happened.
const checkDiskSpace =
  (checkDiskSpaceImport as unknown as { default?: typeof checkDiskSpaceImport }).default ?? checkDiskSpaceImport

const LOW_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
export const CRITICAL_DISK_STOP_BYTES = 500 * 1024 * 1024 // 500MB - safely stop recordings below this

export async function getDiskUsage(saveLocation: string): Promise<DiskUsageInfo> {
  const info = await checkDiskSpace(saveLocation)
  const usedPercent = ((info.size - info.free) / info.size) * 100
  return {
    saveLocation,
    freeBytes: info.free,
    totalBytes: info.size,
    usedPercent: Math.round(usedPercent * 10) / 10,
    lowDiskWarning: info.free < LOW_DISK_WARNING_BYTES
  }
}
