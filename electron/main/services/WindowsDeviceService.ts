import { spawn } from 'node:child_process'
import { logger } from './Logger'

export interface WindowsCameraInfo {
  friendlyName: string
  instanceId: string
  status: string
}

/** Cross-references ffmpeg/DirectShow's camera list against Windows' own PnP
 *  device database (the same source Device Manager and
 *  `Get-PnpDevice -Class Camera` read from) - used only by the Diagnostics
 *  page, never for opening or recording a camera. Lets an operator confirm
 *  independently that two identical-looking webcams really are two separate
 *  physical devices as far as Windows itself is concerned, and that ffmpeg's
 *  count matches Windows' count. */
export function listWindowsCameras(): Promise<WindowsCameraInfo[]> {
  return new Promise((resolve) => {
    // $ProgressPreference suppresses PowerShell's CLIXML progress-stream
    // preamble that otherwise gets mixed into stdout ahead of the JSON when
    // running non-interactively (verified empirically - without it, stdout
    // starts with the JSON on line 1 but is followed by a "#< CLIXML" block
    // on subsequent lines). -EncodedCommand sidesteps all quoting/escaping
    // issues with spawning PowerShell from Node. @(...) forces a JSON array
    // even when exactly one camera is present, since ConvertTo-Json
    // otherwise emits a bare object for a single-item pipeline.
    const script =
      '$ProgressPreference = "SilentlyContinue"; $ErrorActionPreference = "SilentlyContinue"; ' +
      '@(Get-PnpDevice -Class Camera -PresentOnly | Select-Object FriendlyName, InstanceId, Status) | ConvertTo-Json -Compress'
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      logger.error('Failed to spawn PowerShell for Windows camera enumeration', { error: err.message })
      resolve([])
    })
    child.on('close', () => {
      resolve(parsePnpOutput(stdout, stderr))
    })
    // Get-PnpDevice is normally near-instant; guard against it ever hanging
    // (e.g. a stuck WMI provider) the same way ffmpeg device listing does.
    setTimeout(() => {
      if (!child.killed) child.kill()
    }, 8000)
  })
}

function parsePnpOutput(stdout: string, stderr: string): WindowsCameraInfo[] {
  const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim()
  if (!firstLine) {
    if (stderr.trim()) {
      logger.warn('Windows PnP camera enumeration returned no output', { stderr: stderr.trim() })
    }
    return []
  }
  try {
    const parsed = JSON.parse(firstLine) as
      | Array<{ FriendlyName: string; InstanceId: string; Status: string }>
      | { FriendlyName: string; InstanceId: string; Status: string }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((d) => ({ friendlyName: d.FriendlyName, instanceId: d.InstanceId, status: d.Status }))
  } catch (err) {
    logger.error('Failed to parse Windows PnP camera enumeration output', {
      error: (err as Error).message,
      stdout: firstLine
    })
    return []
  }
}
