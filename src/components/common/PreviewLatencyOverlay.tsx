import type { PreviewLatencyDebugInfo } from '../../hooks/useCameraPreview'

/** Live diagnostic readout for the preview-latency verification pass (see
 *  useCameraPreview.ts / PersistentCaptureService's LATENCY_INSTRUMENTATION_ENABLED).
 *  Temporary - remove this along with the two instrumentation flags once
 *  verification is complete, this isn't meant to ship as a permanent
 *  operator-facing feature. */
export function PreviewLatencyOverlay({ debug }: { debug: PreviewLatencyDebugInfo }): JSX.Element {
  const { stats, currentTotalMs, queueDepth, bufferedDurationSeconds, liveEdgeSeconds, playbackDelaySeconds, droppedVideoFrames, totalVideoFrames } =
    debug

  return (
    <div className="absolute bottom-2 right-2 bg-black/80 text-[11px] leading-tight font-mono text-emerald-300 rounded-md px-2 py-1.5 space-y-0.5 pointer-events-auto select-text">
      <div className="text-slate-400 mb-0.5">preview latency (n={stats.sampleCount})</div>
      <Row label="current" value={currentTotalMs !== null ? `${currentTotalMs.toFixed(0)}ms` : '—'} />
      <Row label="avg" value={`${stats.totalEndToEnd.avgMs.toFixed(0)}ms`} />
      <Row label="p95" value={`${stats.totalEndToEnd.p95Ms.toFixed(0)}ms`} />
      <Row label="p99 / max" value={`${stats.totalEndToEnd.p99Ms.toFixed(0)} / ${stats.totalEndToEnd.maxMs.toFixed(0)}ms`} />
      <Row label="queue depth" value={String(queueDepth)} warn={queueDepth > 2} />
      <Row label="buffered" value={`${bufferedDurationSeconds.toFixed(1)}s`} />
      <Row label="live edge" value={`${liveEdgeSeconds.toFixed(1)}s`} />
      <Row label="playback delay" value={`${(playbackDelaySeconds * 1000).toFixed(0)}ms`} warn={playbackDelaySeconds > 0.5} />
      <Row label="dropped frames" value={`${droppedVideoFrames} / ${totalVideoFrames}`} warn={droppedVideoFrames > 0} />
      <button
        type="button"
        onClick={debug.exportSamples}
        className="mt-1 w-full text-center text-slate-300 hover:text-white bg-white/10 hover:bg-white/20 rounded px-1.5 py-0.5"
      >
        export samples ({stats.sampleCount})
      </button>
    </div>
  )
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-400">{label}</span>
      <span className={warn ? 'text-amber-400' : undefined}>{value}</span>
    </div>
  )
}
