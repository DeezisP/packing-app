import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getDiskUsage } from './DiskMonitor'
import type { SaveLocationStatus } from '@shared/types'

const WRITE_PROBE_TIMEOUT_MS = 5000

/** Walks up to the nearest ancestor that actually exists, so we can still
 *  report free disk space for a not-yet-created folder (e.g. while the user
 *  is typing a new path in Settings, before confirming folder creation). */
function nearestExistingAncestor(targetPath: string): string {
  let current = targetPath
  let parent = path.dirname(current)
  while (!fs.existsSync(current) && parent !== current) {
    current = parent
    parent = path.dirname(current)
  }
  return current
}

/** Proves write access with a real probe file instead of fs.access(), which
 *  can report false positives on Windows ACLs/network shares. Races against
 *  a timeout so an unreachable network drive fails fast instead of hanging
 *  the recording pipeline. */
async function canWrite(targetPath: string): Promise<boolean> {
  const probePath = path.join(targetPath, `.write-test-${process.pid}-${Date.now()}`)
  const probe = (async (): Promise<boolean> => {
    await fsp.writeFile(probePath, 'ok')
    await fsp.unlink(probePath)
    return true
  })()
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WRITE_PROBE_TIMEOUT_MS))
  try {
    return await Promise.race([probe, timeout])
  } catch {
    return false
  }
}

/** Validates a candidate save folder: does it exist, is it actually
 *  writable, and how much free space is left on that drive. Used both for
 *  live validation while editing Settings and as a guard right before a
 *  recording is allowed to start. */
export async function validateSaveLocation(targetPath: string): Promise<SaveLocationStatus> {
  const exists = fs.existsSync(targetPath)
  let writable = false
  let error: string | null = null

  if (exists) {
    writable = await canWrite(targetPath)
    if (!writable) {
      error = 'Folder exists but is not writable. Check permissions or choose another folder.'
    }
  } else {
    error = 'Folder does not exist.'
  }

  let freeBytes = 0
  let totalBytes = 0
  try {
    const diskCheckPath = exists ? targetPath : nearestExistingAncestor(targetPath)
    const usage = await getDiskUsage(diskCheckPath)
    freeBytes = usage.freeBytes
    totalBytes = usage.totalBytes
  } catch (err) {
    error = error ?? `Unable to read disk information: ${(err as Error).message}`
  }

  return { path: targetPath, exists, writable, freeBytes, totalBytes, error }
}

export function createSaveLocationFolder(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true })
}
