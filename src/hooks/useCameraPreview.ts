import { useEffect, useRef, useState } from 'react'
import { labelMatchesDeviceName } from '../lib/deviceMatching'
import type { CameraDevice, CaptureChunk, CaptureStatus } from '../../electron/shared/types'

/** Chromium redacts every device's `label` (and gives every device the same
 *  unstable placeholder `deviceId`) in `enumerateDevices()` until the current
 *  page has completed at least one actually-granted `getUserMedia()` call -
 *  an Electron `setPermissionRequestHandler`/`setPermissionCheckHandler` that
 *  auto-approves media does NOT by itself unlock this; Chromium still waits
 *  for a real capture grant to have happened in this session. Confirmed via
 *  this app's own diagnostic logging. Only matters for the getUserMedia
 *  path below - a camera under persistent capture never calls getUserMedia
 *  at all. */
let labelsUnlocked = false
async function ensureDeviceLabelsUnlocked(): Promise<void> {
  if (labelsUnlocked) return
  const before = await navigator.mediaDevices.enumerateDevices()
  const needsPrimer = before.some((d) => d.kind === 'videoinput' && !d.label)
  window.electronAPI.system.log('info', 'Preview stage: label-unlock check', {
    needsPrimer,
    videoInputCount: before.filter((d) => d.kind === 'videoinput').length,
    labels: before.filter((d) => d.kind === 'videoinput').map((d) => d.label)
  })
  if (needsPrimer) {
    try {
      const primer = await navigator.mediaDevices.getUserMedia({ video: true })
      primer.getTracks().forEach((t) => t.stop())
      const after = await navigator.mediaDevices.enumerateDevices()
      window.electronAPI.system.log('info', 'Preview stage: label-unlock primer result', {
        labels: after.filter((d) => d.kind === 'videoinput').map((d) => d.label)
      })
    } catch (err) {
      window.electronAPI.system.log('warn', 'Preview stage: label-unlock primer failed', {
        error: (err as Error).message
      })
    }
  }
  labelsUnlocked = true
}

/** Picks the first H.264 profile/level MIME string this Chromium build's
 *  MediaSource actually supports - tried broadest-compatible first (High,
 *  Main, Baseline) down to a bare, unparameterized fallback. */
const CANDIDATE_MIME_TYPES = [
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="avc1.4d0028"',
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4'
]
function pickSupportedMimeType(): string | null {
  for (const mime of CANDIDATE_MIME_TYPES) {
    if (window.MediaSource?.isTypeSupported(mime)) return mime
  }
  return null
}

/** How much buffered history a live SourceBuffer is allowed to accumulate
 *  before older ranges get trimmed - this is a live view, not a scrubbable
 *  player, so there's no reason to ever keep more than a few seconds behind
 *  the playhead. */
const BUFFER_RETENTION_SECONDS = 15
/** If playback ever falls this far behind the live edge of what's actually
 *  buffered, jump forward instead of continuing to play catch-up at 1x speed
 *  forever. Originally 0.6 - lowered to 0.35 after a real captured session
 *  (exported via the overlay's own "export samples", 85 usable fragments)
 *  showed updateEndToPresented sitting at a *steady* ~300ms, not spiking
 *  briefly - 0.6 was too far above that to ever act as the safety net it was
 *  meant to be. Still comfortably above CATCH_UP_ENGAGE_SECONDS so ordinary
 *  operation near the target cushion doesn't trigger a jump - only a genuine
 *  stall (GC pause, slow paint, decode hiccup) should. */
const MAX_LIVE_EDGE_LAG_SECONDS = 0.35
/** Below MAX_LIVE_EDGE_LAG_SECONDS' hard-jump threshold, lag is nudged down
 *  continuously instead of left alone. A speed change is the standard
 *  technique real low-latency live players (e.g. YouTube Live, Twitch's
 *  low-latency mode) use to converge on the live edge without a visible cut.
 *  Two independent thresholds (not one) avoid rapid on/off toggling right at
 *  a single boundary: catch-up engages above CATCH_UP_ENGAGE and only
 *  disengages once back under CATCH_UP_DISENGAGE. */
const CATCH_UP_ENGAGE_SECONDS = 0.12
const CATCH_UP_DISENGAGE_SECONDS = 0.04
/** Was 1.03 (3% faster) - the same real captured session showed lag barely
 *  narrowing over ~11 seconds of continuous catch-up (302ms -> 281ms
 *  average across 5 chunks of the session). The math explains why: closing
 *  a 300ms gap at 3% takes ~10s of uninterrupted catch-up, far slower than
 *  new lag-inducing events (a stall, a reconnect) can plausibly be avoided
 *  over a multi-hour shift. 8% closes the same gap in under 4s while still
 *  being a standard, imperceptible-to-glance live-player catch-up rate (real
 *  low-latency players commonly use 1.05-1.1). */
const CATCH_UP_PLAYBACK_RATE = 1.08
/** How close to the live edge INITIAL_LIVE_EDGE_SNAP jumps on session start,
 *  rather than 0 (see below) - a nonzero cushion so playback doesn't sit
 *  exactly at the edge with zero lookahead, which would turn any minor
 *  fragment-arrival jitter into a visible stall/rebuffer instead of just
 *  being absorbed by a few frames of headroom. */
const INITIAL_LIVE_EDGE_CUSHION_SECONDS = 0.08

/** Attaches a camera's live feed to a `<video>` element, identified by its
 *  unique `id` (ffmpeg's DirectShow device path) rather than its friendly
 *  name - two identical camera models report the exact same
 *  `navigator.mediaDevices` label, so matching by label alone can't tell
 *  them apart.
 *
 *  A camera with an active persistent capture session (see
 *  PersistentCaptureService - true for every camera currently
 *  enabled+assigned+connected to a station) is played via Media Source
 *  Extensions, fed continuously over IPC (see preload's `capture` API) -
 *  the *same* encoded H.264 stream ffmpeg is already producing. That is
 *  what makes the preview continuous across a recording starting or
 *  stopping: the camera is never released, reconnected, or handed between
 *  two different code paths for that.
 *
 *  `allowGetUserMediaFallback` (default true) controls what happens when
 *  persistent capture *isn't* active for this camera:
 *  - `true` (TestCameraModal, previewing a spare/candidate camera with no
 *    station assignment): falls back to a plain getUserMedia attach, same
 *    as this app did everywhere before this redesign.
 *  - `false` (StationCard, previewing a station's own assigned camera):
 *    never calls getUserMedia - a station-owned camera's persistent
 *    session is expected to exist (or come up shortly after app launch/a
 *    camera reassignment), and both trying to open it at once is exactly
 *    the deadlock this flag avoids: whichever of the two grabbed the
 *    exclusive device first would permanently block the other, since
 *    nothing asks a getUserMedia holder to let go anymore (see the
 *    release/resume handshake this redesign removed). Shows nothing
 *    (`connecting: true`) until the persistent session comes up instead -
 *    caught via the `onStatusChanged` push event from the main process,
 *    never via a renderer-side polling timer. This app already learned
 *    the hard way, for a different feature (the overlay canvas's
 *    requestAnimationFrame loop), that Chromium can suspend a renderer's
 *    own JS timers when its window isn't the active/visible one - a
 *    `setInterval` retry loop here would carry the exact same risk of
 *    silently never firing. The only race a pure event listener leaves is
 *    "capture started in the instant before this listener was registered",
 *    which `recheckIfWaiting` closes with one more direct status query
 *    immediately after registering it - not a retry loop, just closing a
 *    single narrow window once. */
export function useCameraPreview(
  cameraId: string | null,
  cameras: CameraDevice[],
  externalVideoRef?: React.RefObject<HTMLVideoElement>,
  /** Requested as `ideal` (never `exact`) getUserMedia constraints for the
   *  fallback path only - a camera under persistent capture ignores this
   *  entirely, since its actual mode was already negotiated when capture
   *  started (see StationManager.reconcileCaptureForStation). */
  preset?: { width: number; height: number; fps: number },
  allowGetUserMediaFallback = true
): {
  videoRef: React.RefObject<HTMLVideoElement>
  error: string | null
  /** True only when `allowGetUserMediaFallback` is false and this camera's
   *  persistent capture session hasn't come up yet - distinct from `error`
   *  since this is an expected, usually-brief startup state, not a failure. */
  connecting: boolean
} {
  const ownVideoRef = useRef<HTMLVideoElement>(null)
  const videoRef = externalVideoRef ?? ownVideoRef
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const target = cameraId ? (cameras.find((c) => c.id === cameraId) ?? null) : null
  const occurrence = target
    ? cameras
        .filter((c) => c.name === target.name)
        .sort((a, b) => a.index - b.index)
        .findIndex((c) => c.id === target.id)
    : -1

  useEffect(() => {
    if (!target) {
      setError(null)
      setConnecting(false)
      return
    }

    let cancelled = false
    let mode: 'mse' | 'getUserMedia' | 'waiting' | null = null
    let getUserMediaStream: MediaStream | null = null
    let mediaSource: MediaSource | null = null
    let objectUrl: string | null = null
    let sourceBuffer: SourceBuffer | null = null
    let sourceBufferAbort: AbortController | null = null
    const pendingChunks: Uint8Array[] = []
    let appending = false
    let catchingUp = false
    // See INITIAL_LIVE_EDGE_CUSHION_SECONDS - resyncToLiveEdge's normal
    // hard-jump threshold (MAX_LIVE_EDGE_LAG_SECONDS) is deliberately too
    // high to fire on a fresh session start (a real captured session showed
    // playback starting ~350ms behind and the ordinary catch-up rate never
    // meaningfully closing that within the session), so a session's very
    // first resync gets a dedicated one-time snap instead of waiting to
    // cross that threshold. False once this fires for the current session.
    let hasSnappedToLiveEdge = false

    function appendNext(): void {
      if (appending || !sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) return
      const next = pendingChunks.shift()!
      appending = true
      try {
        // Electron's structured-clone IPC always backs this with a real
        // ArrayBuffer at runtime (never SharedArrayBuffer) - the cast is
        // only needed because TS's stricter Buffer/Uint8Array generics
        // don't know that.
        sourceBuffer.appendBuffer(next as BufferSource)
      } catch (err) {
        appending = false
        window.electronAPI.system.log('warn', 'Live preview: appendBuffer failed', {
          cameraId: target!.id,
          error: (err as Error).message
        })
      }
    }

    function trimBuffer(): void {
      if (!sourceBuffer || sourceBuffer.updating) return
      const video = videoRef.current
      const buffered = sourceBuffer.buffered
      if (!video || buffered.length === 0) return
      const removeEnd = video.currentTime - BUFFER_RETENTION_SECONDS
      if (removeEnd > buffered.start(0) + 1) {
        try {
          sourceBuffer.remove(buffered.start(0), removeEnd)
        } catch {
          // best-effort housekeeping only
        }
      }
    }

    /** Corrects drift that would otherwise never recover on its own - normal
     *  HTMLMediaElement playback only ever advances at 1x speed from wherever
     *  it currently is, so a stall never "catches back up" by itself. A clean
     *  jump to an already-buffered timestamp is not a seek that needs
     *  fetching/decoding new data (it's already sitting in the SourceBuffer),
     *  so this doesn't introduce a new stall of its own. */
    function resyncToLiveEdge(): void {
      const video = videoRef.current
      if (!video || !sourceBuffer || sourceBuffer.buffered.length === 0) return
      const liveEdge = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)

      // One-time snap for this session, the first moment there's anything
      // buffered to snap to. Without this, currentTime sits at 0 while the
      // browser plays native 1x from the start of the buffer, and none of
      // the ordinary lag-correction below fires until lag exceeds
      // MAX_LIVE_EDGE_LAG_SECONDS - a threshold deliberately set well above
      // normal jitter, so it doesn't fire fast enough to prevent that
      // startup gap from becoming this session's steady-state baseline lag.
      // No visible cut results: nothing has been presented to the viewer
      // yet at this point, so there's nothing for a jump to visibly
      // interrupt.
      if (!hasSnappedToLiveEdge) {
        hasSnappedToLiveEdge = true
        video.currentTime = Math.max(0, liveEdge - INITIAL_LIVE_EDGE_CUSHION_SECONDS)
        return
      }

      if (liveEdge - video.currentTime > MAX_LIVE_EDGE_LAG_SECONDS) {
        video.currentTime = liveEdge
        // A hard jump already puts playback essentially at the live edge -
        // no need for the catch-up rate to also be active right after one.
        catchingUp = false
        video.playbackRate = 1
      }
    }

    /** Continuous, imperceptible alternative to resyncToLiveEdge's hard jump
     *  for the much smaller lag that's normal, healthy operation - without
     *  this, any lag under MAX_LIVE_EDGE_LAG_SECONDS just sits there
     *  forever uncorrected, since that threshold is deliberately set well
     *  above it. Hysteresis (two thresholds, not one) avoids toggling
     *  playbackRate on and off every cycle right at a single boundary. */
    function applyCatchUpRate(): void {
      const video = videoRef.current
      if (!video || !sourceBuffer || sourceBuffer.buffered.length === 0) return
      const liveEdge = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
      const lag = liveEdge - video.currentTime
      if (!catchingUp && lag > CATCH_UP_ENGAGE_SECONDS) {
        catchingUp = true
        video.playbackRate = CATCH_UP_PLAYBACK_RATE
      } else if (catchingUp && lag < CATCH_UP_DISENGAGE_SECONDS) {
        catchingUp = false
        video.playbackRate = 1
      }
    }

    async function startMse(initSegment: Uint8Array): Promise<void> {
      const mimeType = pickSupportedMimeType()
      const video = videoRef.current
      if (!mimeType || !video) {
        setError('This browser cannot play the live preview format')
        return
      }
      mode = 'mse'
      setConnecting(false)
      mediaSource = new MediaSource()
      // `video.srcObject = mediaSource` (the newer, no-object-URL-needed
      // attachment method) is not supported by this Electron/Chromium
      // build's HTMLMediaElement - confirmed empirically: it throws
      // "provided value is not of type (MediaSourceHandle or MediaStream)".
      // The classic object-URL attachment is the one that actually works
      // here; the URL is revoked in stopMse() once this session ends.
      objectUrl = URL.createObjectURL(mediaSource)
      video.src = objectUrl
      await new Promise<void>((resolve) => {
        mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true })
      })
      if (cancelled || mode !== 'mse') return
      sourceBuffer = mediaSource.addSourceBuffer(mimeType)
      sourceBuffer.mode = 'sequence'
      // Removed (not just disabled) in stopMse() via this controller - a
      // bare `sourceBuffer.onupdateend = null` looks like it detaches the
      // listener below but does NOT: that assigns the separate `onupdateend`
      // IDL-attribute slot, which was never used to register it in the
      // first place (addEventListener and .onupdateend are independent
      // mechanisms). The listener stayed attached to the old SourceBuffer
      // object forever, so if it ever fired again after this MediaSource
      // was superseded, it would touch a `sourceBuffer` closure variable
      // that a *newer* transition now owns - a real contributor to the
      // "This SourceBuffer has been removed from the parent media source"
      // crash seen in production.
      sourceBufferAbort = new AbortController()
      sourceBuffer.addEventListener(
        'updateend',
        () => {
          appending = false
          trimBuffer()
          resyncToLiveEdge()
          applyCatchUpRate()
          appendNext()
        },
        { signal: sourceBufferAbort.signal }
      )
      sourceBuffer.addEventListener(
        'error',
        () => {
          // A genuine demuxer/parse failure - the MediaSource is now in
          // 'ended' state and further appends would just throw, so surface it
          // as an error rather than silently continuing to try.
          const message = video.error?.message ?? 'Live preview stream error'
          window.electronAPI.system.log('warn', 'Live preview: SourceBuffer parse error', {
            cameraId: target!.id,
            videoError: video.error ? { code: video.error.code, message: video.error.message } : null
          })
          if (!cancelled) setError(message)
        },
        { signal: sourceBufferAbort.signal }
      )
      pendingChunks.push(initSegment)
      appendNext()
      setError(null)
    }

    function stopMse(): void {
      sourceBufferAbort?.abort()
      sourceBufferAbort = null
      if (mediaSource && mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream()
        } catch {
          // best-effort
        }
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
      mediaSource = null
      sourceBuffer = null
      pendingChunks.length = 0
      appending = false
      // applyCatchUpRate can leave the video element's playbackRate at
      // CATCH_UP_PLAYBACK_RATE when this session ends mid-catch-up (camera
      // swap, capture going inactive) - catchingUp itself is reset for free
      // by the next startMse() only if a *new* effect run allocates a fresh
      // closure, but a reconnect within the same effect instance (stopMse
      // followed by another startMse without cameraId changing) reuses this
      // same `catchingUp` variable, so both it and the DOM property need an
      // explicit reset here rather than relying on that happening elsewhere.
      catchingUp = false
      if (videoRef.current) videoRef.current.playbackRate = 1
      // Same reasoning as catchingUp above: a reconnect within the same
      // effect instance must re-arm the one-time initial snap, or the next
      // startMse() would skip straight to the ordinary (slower-to-converge)
      // lag correction for what is, from that fresh SourceBuffer's
      // perspective, a brand new session starting at currentTime 0 again.
      hasSnappedToLiveEdge = false
    }

    async function attachGetUserMedia(): Promise<void> {
      mode = 'getUserMedia'
      setConnecting(false)
      try {
        await ensureDeviceLabelsUnlocked()
        if (cancelled || mode !== 'getUserMedia') return

        const devices = await navigator.mediaDevices.enumerateDevices()
        const matches = devices.filter((d) => d.kind === 'videoinput' && labelMatchesDeviceName(d.label, target!.name))
        const match = matches[occurrence] ?? matches[0]

        window.electronAPI.system.log('info', 'Preview stage: attaching camera (getUserMedia)', {
          cameraId: target!.id,
          cameraName: target!.name,
          occurrence,
          chromiumDeviceId: match?.deviceId ?? null
        })

        const videoConstraints: MediaTrackConstraints = {
          ...(match ? { deviceId: { exact: match.deviceId } } : {}),
          ...(preset
            ? { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } }
            : {})
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true
        })

        if (cancelled || mode !== 'getUserMedia') {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        getUserMediaStream = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setError(null)
      } catch (err) {
        const message = (err as Error).message
        window.electronAPI.system.log('warn', 'Preview stage: attach failed', {
          cameraId: target!.id,
          cameraName: target!.name,
          error: message
        })
        if (!cancelled) setError(message)
      }
    }

    function stopGetUserMedia(): void {
      if (getUserMediaStream) {
        getUserMediaStream.getTracks().forEach((t) => t.stop())
        getUserMediaStream = null
      }
    }

    /** One direct status query, used both to close the narrow "capture
     *  started right before we started listening" race and by the event
     *  listener itself - never a retry loop (see this hook's own doc
     *  comment for why a timer is unsafe here). */
    async function recheckIfWaiting(): Promise<void> {
      if (cancelled || mode !== 'waiting') return
      const status = await window.electronAPI.capture.getStatus(target!.id)
      if (cancelled || mode !== 'waiting') return
      if (status.active && status.initSegment) await startMse(status.initSegment)
    }

    function waitForCapture(): void {
      mode = 'waiting'
      setConnecting(true)
      setError(null)
    }

    // startMse/attachGetUserMedia/stopMse all mutate shared, closure-scoped
    // state (mediaSource, sourceBuffer, objectUrl, mode) with no per-call
    // isolation. If two transitions ever ran concurrently - confirmed: the
    // initial attach() and an onStatusChanged event racing right at startup,
    // exactly the "capture session comes up while attach()'s own getStatus()
    // is still in flight" case the comment below already anticipated but
    // didn't actually prevent - the loser's `mode !== 'mse'` guard doesn't
    // catch it, because both transitions set mode to the same value: it can
    // only tell "did *some* transition reach mse", not "was mine the one
    // that did". That let a stale continuation call
    // `mediaSource.addSourceBuffer()` on a MediaSource a newer transition
    // had already superseded by reassigning video.src, producing a
    // SourceBuffer whose parent MediaSource gets torn out from under it -
    // the exact "This SourceBuffer has been removed from the parent media
    // source" crash seen in production. Serializing every transition
    // through this queue - never starting the next one until the previous
    // one, including all its internal awaits, has fully finished - removes
    // the possibility of two transitions ever touching this shared state at
    // once, rather than patching each individual race point with more mode
    // checks.
    let pendingTransition: Promise<void> = Promise.resolve()
    function enqueueTransition(fn: () => Promise<void>): void {
      pendingTransition = pendingTransition.then(async () => {
        if (cancelled) return
        try {
          await fn()
        } catch (err) {
          window.electronAPI.system.log('warn', 'Live preview: transition failed', {
            cameraId: target!.id,
            error: (err as Error).message
          })
        }
      })
    }

    // Registered before attach()'s own async work starts, so a capture
    // session that starts while that first getStatus() call is still in
    // flight is caught by this listener rather than lost.
    const offChunk = window.electronAPI.capture.onChunk((chunk: CaptureChunk) => {
      if (chunk.cameraId !== target!.id || mode !== 'mse') return
      pendingChunks.push(chunk.data)
      appendNext()
    })

    const offStatus = window.electronAPI.capture.onStatusChanged((status: CaptureStatus) => {
      if (status.cameraId !== target!.id || cancelled) return
      enqueueTransition(async () => {
        if (status.active && mode !== 'mse') {
          stopGetUserMedia()
          const fresh = await window.electronAPI.capture.getStatus(target!.id)
          if (!cancelled && fresh.active && fresh.initSegment) await startMse(fresh.initSegment)
        } else if (!status.active && mode === 'mse') {
          stopMse()
          if (allowGetUserMediaFallback) {
            await attachGetUserMedia()
          } else {
            waitForCapture()
          }
        }
      })
    })

    async function attach(): Promise<void> {
      const status = await window.electronAPI.capture.getStatus(target!.id)
      if (cancelled) return
      if (status.active && status.initSegment) {
        await startMse(status.initSegment)
      } else if (allowGetUserMediaFallback) {
        await attachGetUserMedia()
      } else {
        waitForCapture()
        await recheckIfWaiting()
      }
    }

    enqueueTransition(attach)

    return () => {
      cancelled = true
      offChunk()
      offStatus()
      stopGetUserMedia()
      stopMse()
    }
    // Depends on preset's primitive fields rather than the object reference,
    // so a caller passing a fresh `{ width, height, fps }` literal every
    // render (e.g. derived from QUALITY_PRESETS each time) doesn't
    // needlessly re-attach the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, occurrence, preset?.width, preset?.height, preset?.fps, allowGetUserMediaFallback])

  return { videoRef, error, connecting }
}
