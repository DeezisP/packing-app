import { useEffect, useState } from 'react'
import { formatHms } from '../../electron/shared/types'
import type { StationConfig, StationRuntimeState, OverlayFieldData } from '../../electron/shared/types'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatTimeLocal(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const SAMPLE_BARCODE = 'ORD240715001'
const SAMPLE_TIMER = '00:02:45'

/** Drives the live overlay preview shown over a station's camera feed. While
 *  actually recording, shows the real barcode/timer; otherwise falls back to
 *  representative sample values so the preview still looks meaningful before
 *  a scan starts - date/time keep ticking either way, matching the "must
 *  update continuously" behavior of the real burned-in overlay. */
export function useOverlayFieldData(
  station: StationConfig,
  state: StationRuntimeState | undefined
): OverlayFieldData {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const recording = state?.status === 'recording' && state.barcode

  return {
    barcode: recording ? state!.barcode! : SAMPLE_BARCODE,
    date: formatDateLocal(now),
    time: formatTimeLocal(now),
    timer: recording ? formatHms(state!.elapsedSeconds) : SAMPLE_TIMER,
    station: station.name,
    camera: station.cameraName ?? 'Not assigned'
  }
}
