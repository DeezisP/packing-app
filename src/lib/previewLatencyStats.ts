/** Stats engine for the preview-latency verification pass (see
 *  useCameraPreview.ts). Every timestamp is wall-clock milliseconds
 *  (Date.now()-comparable) - see useCameraPreview's perfToWallClockOffsetMs
 *  for how renderer-side performance.now() readings get onto that same
 *  clock, since performance.now() is NOT directly comparable across the
 *  main/renderer process boundary in Electron (each process has its own
 *  independent epoch origin). */
export interface PreviewLatencySample {
  /** Best-effort approximation of when this fragment's opening keyframe
   *  entered ffmpeg's filter graph (see PersistentCaptureService's
   *  `showinfo` filter) - not a hardware-verified capture timestamp. */
  captureAtApprox: number
  /** When this fragment's bytes were fully available in the main process -
   *  the earliest point with byte-for-byte certainty; "encode" and "mux"
   *  aren't independently observable without patching ffmpeg's source, so
   *  captureAtApprox -> fragmentEmittedAt bounds both stages combined. */
  fragmentEmittedAt: number
  ipcReceivedAt: number
  appendBeginAt: number
  appendEndAt: number
  presentedAt: number
}

export interface StageStats {
  avgMs: number
  medianMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

export interface LatencyStats {
  sampleCount: number
  captureToFragment: StageStats
  fragmentToIpc: StageStats
  ipcToAppendBegin: StageStats
  appendToUpdateEnd: StageStats
  updateEndToPresented: StageStats
  totalEndToEnd: StageStats
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx]
}

function summarize(values: number[]): StageStats {
  if (values.length === 0) return { avgMs: 0, medianMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const avgMs = values.reduce((sum, v) => sum + v, 0) / values.length
  return {
    avgMs,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1]
  }
}

/** ~7200 samples covers the requested 30-minute run at this pipeline's
 *  ~4 fragments/sec (GOP_SECONDS=0.25) with room to spare; capped so a
 *  long-running verification session doesn't itself become the kind of
 *  unbounded memory growth this pass is supposed to be ruling out. */
const MAX_RETAINED_SAMPLES = 10000

export class LatencyStatsCollector {
  private samples: PreviewLatencySample[] = []

  addSample(sample: PreviewLatencySample): void {
    this.samples.push(sample)
    if (this.samples.length > MAX_RETAINED_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_RETAINED_SAMPLES)
    }
  }

  latest(): PreviewLatencySample | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null
  }

  count(): number {
    return this.samples.length
  }

  getStats(): LatencyStats {
    const captureToFragment = this.samples.map((s) => s.fragmentEmittedAt - s.captureAtApprox)
    const fragmentToIpc = this.samples.map((s) => s.ipcReceivedAt - s.fragmentEmittedAt)
    const ipcToAppendBegin = this.samples.map((s) => s.appendBeginAt - s.ipcReceivedAt)
    const appendToUpdateEnd = this.samples.map((s) => s.appendEndAt - s.appendBeginAt)
    const updateEndToPresented = this.samples.map((s) => s.presentedAt - s.appendEndAt)
    const totalEndToEnd = this.samples.map((s) => s.presentedAt - s.captureAtApprox)
    return {
      sampleCount: this.samples.length,
      captureToFragment: summarize(captureToFragment),
      fragmentToIpc: summarize(fragmentToIpc),
      ipcToAppendBegin: summarize(ipcToAppendBegin),
      appendToUpdateEnd: summarize(appendToUpdateEnd),
      updateEndToPresented: summarize(updateEndToPresented),
      totalEndToEnd: summarize(totalEndToEnd)
    }
  }

  /** Full-session dump for offline analysis - see the "Export" button on
   *  PreviewLatencyOverlay, wired through the existing diagnostics.export
   *  IPC channel (a save-file dialog + plain text write, already used for
   *  Settings' diagnostics export - reused here rather than adding a new
   *  IPC channel for the same "save some text to a file" operation). */
  exportJson(): string {
    return JSON.stringify({ exportedAt: new Date().toISOString(), sampleCount: this.samples.length, samples: this.samples }, null, 2)
  }

  clear(): void {
    this.samples = []
  }
}
