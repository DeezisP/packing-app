import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveFfmpegPath } from './FfmpegLocator'
import { logger } from './Logger'
import { recordingEngine, summarizeFfmpegError, isEncoderInitError, ENCODER_PRIORITY, buildEncoderArgs } from './RecordingEngine'
import type { HardwareEncoder } from './RecordingEngine'
import { defaultPaths } from './PathService'
import { buildOverlayLines, formatDateLocal, formatTimeLocal, formatHms } from '@shared/types'
import type { OverlayConfig, FragmentTiming } from '@shared/types'

const DEVICE_OPEN_GRACE_MS = 3000
const OPEN_DEVICE_RETRY_ATTEMPTS = 3
const OPEN_DEVICE_RETRY_DELAY_MS = 700
const OVERLAY_UPDATE_INTERVAL_MS = 1000
/** Temporary, one-off toggle for the preview-latency verification pass
 *  (measuring the real effect of GOP_SECONDS + the renderer resync + the
 *  encoder tuning changes) - not meant to stay on permanently. Turn off once
 *  that verification is done; the `showinfo` filter and stderr parsing it
 *  gates are cheap but there's no reason to carry them in every production
 *  build once the numbers are in. */
const LATENCY_INSTRUMENTATION_ENABLED = true
const GRACEFUL_STOP_TIMEOUT_MS = 8000

/** The encoder's keyframe interval. Used to be the tightest knob on preview
 *  latency, because the preview's fragmented-mp4 leg used to only be able to
 *  close a fragment at a keyframe (movflags=frag_keyframe) - a fragment
 *  never reached the renderer before its keyframe boundary closed. That
 *  coupling is gone now that the pipe:1 leg fragments at every frame instead
 *  (movflags=frag_every_frame - see the tee spec below), so this constant no
 *  longer bounds preview lag at all. What it still controls: the segment
 *  archive leg's random-access/error-resilience granularity, and (via
 *  SEGMENT_SECONDS needing to stay a multiple of it) how finely the archive
 *  can be cut. Left unchanged for now - only the preview-leg coupling this
 *  comment used to describe was in scope for the frag_every_frame change. */
const GOP_SECONDS = 0.25
/** Archive segment file length - deliberately independent of GOP_SECONDS
 *  (as long as it's a multiple of it, so the segment muxer still cuts
 *  cleanly on a keyframe rather than waiting for the next one past its
 *  target). Unrelated to preview latency: this only bounds the "wait for
 *  the in-progress segment to close" delay at Stop (see finalizeRecording).
 *  Verified against real hardware at 1080p60/NVENC before being relied on:
 *  keyframe-aligned cuts, each segment independently decodable, real-time
 *  speed the whole session. */
const SEGMENT_SECONDS = 1
/** How long past its own expected close time a segment is given before
 *  finalizeRecording gives up waiting for it - generous relative to
 *  SEGMENT_SECONDS since a slow disk or a momentary encoder hiccup
 *  shouldn't turn into a failed recording. */
const SEGMENT_CLOSE_TIMEOUT_MS = SEGMENT_SECONDS * 1000 * 3 + 5000
/** Segments older than this (from when they closed) are deleted by the
 *  periodic sweep, unless still needed by an in-flight recording - bounds
 *  disk usage from the continuous archive leg without depending on any
 *  recording ever actually happening. */
const SEGMENT_RETENTION_MS = 2 * 60 * 1000
const SEGMENT_SWEEP_INTERVAL_MS = 30 * 1000

const MARGIN = 20
const BOX_PADDING = 8
const WINDOWS_ARIAL_PATH = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf')

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface OverlayParams {
  config: OverlayConfig
  staticData: { station: string; camera: string }
}

export interface StartCaptureParams {
  cameraId: string
  stationId: string
  micName: string | null
  width: number
  height: number
  fps: number
  bitrateKbps: number
  overlay: OverlayParams | null
}

interface SegmentInfo {
  path: string
  openedAt: number
  closedAt: number | null
}

interface RecordingMarker {
  barcode: string
  startedAt: number
  firstSegmentIndex: number
}

/** Incrementally splits a continuous fragmented-MP4 byte stream into
 *  top-level ISO-BMFF boxes, classifying the leading ftyp/moov/free boxes as
 *  the one-time "init segment" (cached and replayed to any renderer that
 *  starts listening after capture already began) and everything from the
 *  first moof/styp onward as ongoing "fragments" forwarded live. This is the
 *  entire relay mechanism - no need to understand MP4 semantics beyond box
 *  size/type, since a browser's own MediaSource demuxer does the real
 *  parsing once these bytes reach a SourceBuffer. */
class Mp4BoxSplitter {
  private buffer = Buffer.alloc(0)
  private initChunks: Buffer[] = []
  private initComplete = false
  // A 'moof' describes the samples in the 'mdat' that follows it - MSE
  // can't parse either half alone, so they must reach the SourceBuffer as
  // one atomic append. Stash 'moof' here until its 'mdat' arrives.
  private pendingMoof: Buffer | null = null

  push(chunk: Buffer, onInit: (init: Buffer) => void, onFragment: (fragment: Buffer) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 8) return
      const size = this.buffer.readUInt32BE(0)
      const type = this.buffer.toString('ascii', 4, 8)
      if (size < 8 || size > this.buffer.length) return
      const box = this.buffer.subarray(0, size)
      this.buffer = this.buffer.subarray(size)

      if (!this.initComplete && (type === 'moof' || type === 'styp' || type === 'sidx')) {
        this.initComplete = true
        onInit(Buffer.concat(this.initChunks))
        this.initChunks = []
      } else if (!this.initComplete) {
        this.initChunks.push(box)
        continue
      }

      if (type === 'moof') {
        this.pendingMoof = box
      } else if (this.pendingMoof) {
        onFragment(Buffer.concat([this.pendingMoof, box]))
        this.pendingMoof = null
      } else {
        onFragment(box)
      }
    }
  }
}

interface CaptureSession {
  cameraId: string
  stationId: string
  child: ChildProcess
  encoder: HardwareEncoder
  mode: { width: number; height: number; fps: number }
  segmentDir: string
  segments: SegmentInfo[]
  segmentWatcher: fs.FSWatcher | null
  overlayTextPath: string | null
  overlayTimer: NodeJS.Timeout | null
  overlayParams: OverlayParams | null
  splitter: Mp4BoxSplitter
  initSegment: Buffer | null
  stderrTail: string
  /** Wall-clock (Date.now) moments a keyframe was reported entering the
   *  filter graph by ffmpeg's `showinfo` filter, oldest first - see
   *  LATENCY_INSTRUMENTATION_ENABLED. Exactly one keyframe opens each
   *  fragment (-force_key_frames + movflags=frag_keyframe), so the oldest
   *  entry is always the correct capture-approx match for the next fragment
   *  to close, consumed FIFO in onFragment. */
  pendingKeyframeTimings: number[]
  stderrLineBuffer: string
  recordingMarker: RecordingMarker | null
  stopResolvers: Array<(result: { success: boolean; error: string | null }) => void>
  killTimer: NodeJS.Timeout | null
}

function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

function toFfmpegColor(hex: string, opacityPercent?: number): string {
  const clean = hex.replace('#', '').toLowerCase()
  return opacityPercent === undefined ? `0x${clean}` : `0x${clean}@${(opacityPercent / 100).toFixed(2)}`
}

function buildDrawtextFilter(config: OverlayConfig, overlayTextPath: string, fontFilePath: string | null): string {
  const boxColor = toFfmpegColor(config.backgroundColor, config.backgroundOpacity)
  const fontColor = toFfmpegColor(config.fontColor)
  const lineSpacing = Math.max(2, Math.round(config.fontSize * 0.3))
  const textFile = escapeFfmpegFilterPath(overlayTextPath)
  const inset = MARGIN + BOX_PADDING

  let x: string
  let y: string
  switch (config.position) {
    case 'top-left':
      x = String(inset)
      y = String(inset)
      break
    case 'top-right':
      x = `w-text_w-${inset}`
      y = String(inset)
      break
    case 'bottom-left':
      x = String(inset)
      y = `h-text_h-${inset}`
      break
    case 'bottom-right':
      x = `w-text_w-${inset}`
      y = `h-text_h-${inset}`
      break
  }

  const fontPart = fontFilePath ? `fontfile='${escapeFfmpegFilterPath(fontFilePath)}':` : 'font=Arial:'
  return (
    `drawtext=${fontPart}textfile='${textFile}':reload=1:` +
    `x=${x}:y=${y}:fontsize=${config.fontSize}:fontcolor=${fontColor}:` +
    `box=1:boxcolor=${boxColor}:boxborderw=${BOX_PADDING}:line_spacing=${lineSpacing}`
  )
}

/** Writes the overlay text file drawtext reads live. `recording` is null
 *  between recordings - the overlay then shows date/time/station/camera
 *  (whichever fields are enabled) with barcode and elapsed-timer fields
 *  blank, since there's no active recording for them to describe. This is
 *  the *only* overlay now - the live preview is this same encoded stream,
 *  so there's no separate client-side "preview overlay" to keep in sync
 *  with it anymore. */
function writeOverlayTextFile(
  filePath: string,
  overlay: OverlayParams,
  recording: { barcode: string; startedAt: number } | null
): void {
  const now = new Date()
  const lines = buildOverlayLines(overlay.config, {
    barcode: recording?.barcode ?? '',
    date: formatDateLocal(now),
    time: formatTimeLocal(now),
    timer: recording ? formatHms(Math.max(0, Math.floor((Date.now() - recording.startedAt) / 1000))) : '',
    station: overlay.staticData.station,
    camera: overlay.staticData.camera
  })
  try {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
  } catch (err) {
    logger.warn('Persistent capture: failed to update overlay text file', { filePath, error: (err as Error).message })
  }
}

/** Owns every camera this app has open, for as long as it stays
 *  assigned+connected - never just for the duration of a recording (see
 *  StationManager, which starts/stops a session per camera based on
 *  assignment/connectivity, independent of barcode-driven record/stop).
 *  One ffmpeg process per camera hardware-encodes continuously and `tee`s
 *  the same encoded stream to two destinations: a rolling keyframe-aligned
 *  segment archive on disk, and a fragmented-MP4 byte stream relayed to the
 *  renderer for MediaSource Extensions playback. Recording start/stop never
 *  touch this process at all - they only mark which segments a recording
 *  spans (markRecordingStart) and trim/concat them into the final file
 *  (finalizeRecording), which is what makes the live preview continuous
 *  across a record/stop cycle with no reconnect, freeze, or component swap.
 *
 *  This replaces LiveRecordingService's per-recording-process model
 *  entirely - see the incident history that model itself replaced (v1.6.2/
 *  v1.7.5): both tied a second preview channel's lifetime to the recording
 *  process, which is what made every earlier live-preview attempt fragile.
 *  Here the capture process's lifetime is tied only to camera assignment/
 *  connectivity, never to any specific recording, so there is no shutdown
 *  race to have in the first place. */
class PersistentCaptureService extends EventEmitter {
  private sessions = new Map<string, CaptureSession>()
  private sweepTimer: NodeJS.Timeout | null = null

  init(): void {
    this.sweepTimer = setInterval(() => this.sweepOldSegments(), SEGMENT_SWEEP_INTERVAL_MS)
  }

  isActive(cameraId: string): boolean {
    return this.sessions.has(cameraId)
  }

  getInitSegment(cameraId: string): Buffer | null {
    return this.sessions.get(cameraId)?.initSegment ?? null
  }

  /** The width/height/fps this camera's persistent session actually
   *  negotiated at start - queried at recording-finalize time so
   *  verifyRecording can compare the decoded file's real mode against what
   *  this capture was actually running at, not just what was requested. */
  getMode(cameraId: string): { width: number; height: number; fps: number } | null {
    return this.sessions.get(cameraId)?.mode ?? null
  }

  async start(params: StartCaptureParams): Promise<{ success: boolean; error: string | null; encoder: HardwareEncoder | null }> {
    if (this.sessions.has(params.cameraId)) {
      await this.stop(params.cameraId)
    }

    const segmentDir = path.join(defaultPaths.captureCacheDir, sanitizeForPath(params.cameraId))
    fs.mkdirSync(segmentDir, { recursive: true })
    for (const stale of fs.readdirSync(segmentDir)) {
      try {
        fs.unlinkSync(path.join(segmentDir, stale))
      } catch {
        // best-effort cleanup of a previous session's leftovers
      }
    }

    let encoder = await recordingEngine.detectEncoder()

    let overlayTextPath: string | null = null
    let vf: string | null = null
    if (params.overlay) {
      overlayTextPath = path.join(segmentDir, 'overlay.txt')
      const fontFilePath = fs.existsSync(WINDOWS_ARIAL_PATH) ? WINDOWS_ARIAL_PATH : null
      writeOverlayTextFile(overlayTextPath, params.overlay, null)
      vf = buildDrawtextFilter(params.overlay.config, overlayTextPath, fontFilePath)
    }
    // `showinfo` logs one stderr line per frame (n, pts_time, iskey) with no
    // image processing cost - purely a latency-measurement probe, chained
    // before any real filter so it sees a frame as early as this app can
    // observe one (see LATENCY_INSTRUMENTATION_ENABLED and the stderr
    // handler below, which reads it back out).
    if (LATENCY_INSTRUMENTATION_ENABLED) {
      vf = vf ? `showinfo,${vf}` : 'showinfo'
    }

    const deviceSpec = params.micName ? `video=${params.cameraId}:audio=${params.micName}` : `video=${params.cameraId}`
    const gopSize = Math.round(params.fps * GOP_SECONDS)
    const segmentPattern = path.join(segmentDir, 'seg_%06d.mp4').replace(/\\/g, '/')

    const buildArgs = (enc: HardwareEncoder): string[] => [
      '-hide_banner',
      '-loglevel',
      // showinfo logs at AV_LOG_INFO - the normal 'warning' level silences
      // it completely (confirmed empirically: zero showinfo lines reach
      // stderr at 'warning', vs one per frame at 'info'), which is why
      // pendingKeyframeTimings stayed empty and every captureAtApprox
      // silently fell back to the Date.now() default, always exactly equal
      // to fragmentEmittedAt. Only bumped when instrumentation is actually
      // on - 'warning' stays correct for normal operation, where the extra
      // per-frame noise this produces would have no purpose.
      LATENCY_INSTRUMENTATION_ENABLED ? 'info' : 'warning',
      '-stats',
      // Both real, documented input-side options (confirmed via `ffmpeg -h
      // full`), unrelated to the encoder/GOP tuning already done. Neither
      // is needed for correctness here - the format is already fully
      // specified below (-video_size/-framerate/-pixel_format via dshow's
      // own args) - but ffmpeg's generic AVFormat stream-analysis step
      // (avformat_find_stream_info) still runs by default even when told
      // exactly what to expect, and can wait up to -analyzeduration
      // microseconds / read up to -probesize bytes doing so. This is a
      // one-time cost paid once per capture-session start (app launch,
      // camera reassignment, reconnect), not a per-frame steady-state cost -
      // a synthetic-source test found no measurable difference (lavfi
      // resolves its own format instantly regardless of the ceiling), which
      // only proves the generic probing path isn't the bottleneck for a
      // fully-synthetic source - it does not rule this out for a real
      // dshow device, whose negotiation is a different code path entirely
      // and untestable without the real camera. -fflags nobuffer is
      // FFmpeg's own documented latency-reduction flag ("reduce the latency
      // introduced by optional buffering") - real and directly on point,
      // independent of whether the analyzeduration/probesize reduction
      // itself turns out to matter for dshow specifically.
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-fflags',
      'nobuffer',
      '-f',
      'dshow',
      '-rtbufsize',
      '512M',
      '-video_size',
      `${params.width}x${params.height}`,
      '-framerate',
      String(params.fps),
      '-i',
      deviceSpec,
      ...(vf ? ['-vf', vf] : []),
      ...buildEncoderArgs(enc, params.bitrateKbps),
      // Hardware encoders (NVENC/QSV/AMF) default to repeating SPS/PPS
      // in-band before each IDR rather than populating the encoder's
      // extradata - fine for muxers that read codec config straight from
      // the bitstream, but the fragmented-mp4 leg below needs it in
      // extradata to write a non-empty avcC box, and MSE's demuxer (unlike
      // ffmpeg's own decoder, which tolerates in-band SPS/PPS) hard-requires
      // a populated avcC to parse the init segment at all. Confirmed
      // empirically that the `extract_extradata` bitstream filter does NOT
      // fix this specifically under `-f tee`: tee writes every slave's
      // header up front, before any packet - and therefore before that
      // filter has seen one to extract from. `+global_header` instead makes
      // the encoder populate extradata synchronously at open time, with no
      // dependency on packet timing at all.
      '-flags',
      '+global_header',
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(gopSize),
      '-force_key_frames',
      `expr:gte(t,n_forced*${GOP_SECONDS})`,
      ...(params.micName ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      // Real, documented top-level output options (confirmed via `ffmpeg
      // -h`), unrelated to the segment/fragment leg's own per-muxer options
      // below - standard low-latency-streaming practice, zero downside for
      // a pipeline with no meaningful audio/video interleaving to buffer
      // for on the live preview leg.
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-f',
      'tee',
      '-map',
      '0:v',
      // flush_packets=1 on the fragmented leg specifically (confirmed real
      // via `ffmpeg -h muxer=mov`: "enable flushing of the I/O context
      // after each packet") - forces pipe:1 writes out immediately rather
      // than leaving it to the muxer's own (undocumented, for this build)
      // default (-1/auto) buffering choice. Not applied to the segment leg,
      // which isn't latency-sensitive - real files benefit from normal
      // buffered I/O, not per-packet flush syscalls.
      //
      // pipe:1 uses frag_every_frame, not frag_keyframe: with frag_keyframe
      // a fragment could only close at a keyframe, so a frame born right
      // after one could wait up to GOP_SECONDS before its fragment reached
      // the renderer - the dominant term in glass-to-glass preview latency.
      // frag_every_frame (confirmed real via `ffmpeg -h muxer=mov`:
      // "Fragment at every frame") closes one fragment per frame regardless
      // of keyframe boundaries, cutting that wait to ~1 frame interval.
      // Mp4BoxSplitter already treats every moof+mdat pair as one opaque
      // fragment with no keyframe assumption, so this needed no renderer-side
      // change. Safe under MSE's `sequence` mode (already set in
      // useCameraPreview.ts) because fragments are appended in continuous,
      // unbroken decode order - the same technique low-latency CMAF/DASH
      // players use, not a hack. Only applied to the preview leg - the
      // segment archive leg is untouched and still cuts on GOP_SECONDS-paced
      // keyframe boundaries (segment_format=mp4, no frag_* flags), since its
      // segments still need to be independently decodable from a random
      // access point for finalizeRecording's trim/concat.
      `[f=segment:segment_time=${SEGMENT_SECONDS}:reset_timestamps=1:segment_format=mp4:segment_format_options=movflags=+faststart]${segmentPattern}|[f=mp4:movflags=frag_every_frame+empty_moov+default_base_moof:flush_packets=1]pipe:1`
    ]

    let lastError = 'Unknown ffmpeg error'

    for (let encoderAttempt = 0; encoderAttempt < ENCODER_PRIORITY.length; encoderAttempt++) {
      const args = buildArgs(encoder)
      let encoderFailureSeen = false

      for (let deviceAttempt = 1; deviceAttempt <= OPEN_DEVICE_RETRY_ATTEMPTS; deviceAttempt++) {
        logger.info('Persistent capture: starting ffmpeg', {
          cameraId: params.cameraId,
          stationId: params.stationId,
          deviceAttempt,
          encoder,
          commandLine: `${resolveFfmpegPath()} ${args.join(' ')}`
        })

        // eslint-disable-next-line no-await-in-loop
        const result = await this.trySpawn(params, args, encoder, segmentDir, overlayTextPath)
        if (result.success) {
          return { success: true, error: null, encoder }
        }

        lastError = result.error
        if (result.isEncoderIssue) {
          encoderFailureSeen = true
          break
        }

        logger.warn('Persistent capture: ffmpeg failed to open the camera, retrying', {
          cameraId: params.cameraId,
          deviceAttempt,
          error: lastError
        })
        if (deviceAttempt < OPEN_DEVICE_RETRY_ATTEMPTS) {
          // eslint-disable-next-line no-await-in-loop
          await delay(OPEN_DEVICE_RETRY_DELAY_MS)
        }
      }

      if (!encoderFailureSeen || encoder === 'libx264') break
      const next = recordingEngine.demoteEncoder(encoder)
      logger.warn('Persistent capture: encoder failed to start, falling back', {
        cameraId: params.cameraId,
        from: encoder,
        to: next,
        error: lastError
      })
      encoder = next
    }

    if (overlayTextPath) fs.unlink(overlayTextPath, () => undefined)
    return { success: false, error: lastError, encoder: null }
  }

  private trySpawn(
    params: StartCaptureParams,
    args: string[],
    encoder: HardwareEncoder,
    segmentDir: string,
    overlayTextPath: string | null
  ): Promise<{ success: true } | { success: false; error: string; isEncoderIssue: boolean }> {
    return new Promise((resolve) => {
      const ffmpegPath = resolveFfmpegPath()
      const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })

      const session: CaptureSession = {
        cameraId: params.cameraId,
        stationId: params.stationId,
        child,
        encoder,
        mode: { width: params.width, height: params.height, fps: params.fps },
        segmentDir,
        segments: [],
        segmentWatcher: null,
        overlayTextPath,
        overlayTimer: null,
        overlayParams: params.overlay,
        splitter: new Mp4BoxSplitter(),
        initSegment: null,
        stderrTail: '',
        pendingKeyframeTimings: [],
        stderrLineBuffer: '',
        recordingMarker: null,
        stopResolvers: [],
        killTimer: null
      }

      // Segment open/close is tracked via the filesystem, not by parsing
      // ffmpeg's own stderr text - "Opening '...' for writing" is only
      // printed at -loglevel info or above, so at this app's normal
      // -loglevel warning it never appeared and segments silently never got
      // tracked at all (confirmed empirically: real segment files existed
      // on disk the whole time, but session.segments stayed empty forever).
      // A new seg_NNNNNN.mp4 file appearing is itself the ground truth that
      // the previous one just closed and this one just opened - ffmpeg's
      // segment muxer switches output files atomically at each boundary.
      session.segmentWatcher = fs.watch(segmentDir, (_eventType, filename) => {
        if (!filename || !filename.startsWith('seg_') || !filename.endsWith('.mp4')) return
        const fullPath = path.join(segmentDir, filename)
        if (!fs.existsSync(fullPath) || session.segments.some((s) => s.path === fullPath)) return
        const now = Date.now()
        const prev = session.segments[session.segments.length - 1]
        if (prev && prev.closedAt === null) prev.closedAt = now
        session.segments.push({ path: fullPath, openedAt: now, closedAt: null })
      })

      let settled = false
      const settleSuccess = (): void => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        this.sessions.set(params.cameraId, session)
        if (session.overlayParams) {
          session.overlayTimer = setInterval(
            () => writeOverlayTextFile(overlayTextPath!, session.overlayParams!, session.recordingMarker),
            OVERLAY_UPDATE_INTERVAL_MS
          )
        }
        resolve({ success: true })
      }
      const settleFailure = (error: string, stderrTail: string): void => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        resolve({ success: false, error, isEncoderIssue: isEncoderInitError(stderrTail) })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (!settled) settleSuccess()
        session.splitter.push(
          chunk,
          (init) => {
            session.initSegment = init
            // The renderer's live preview can only actually play something
            // once this exists - emitting 'statusChanged' from settleSuccess
            // (as soon as the ffmpeg *process* is merely confirmed alive)
            // fired too early and only once, so any consumer that queried
            // getStatus() at that exact moment saw active:true with a still-
            // null initSegment and had no second signal to ever retry (this
            // event only fires on true active/inactive transitions, not
            // "still active, but now actually has data"). Confirmed via a
            // real hardware test: the live preview never attached until this
            // was moved here.
            this.emit('statusChanged', { cameraId: params.cameraId, active: true })
          },
          (fragment) => {
            // See pendingKeyframeTimings' doc comment: exactly one keyframe
            // opens each fragment, so the oldest pending timing is always
            // this fragment's - undefined (not a fabricated Date.now()
            // fallback) if instrumentation is off or the queue is
            // unexpectedly empty, so a stats consumer can tell "not
            // measured" apart from a real (if imperfect) measurement.
            const timing: FragmentTiming | undefined = LATENCY_INSTRUMENTATION_ENABLED
              ? { captureAtApprox: session.pendingKeyframeTimings.shift() ?? Date.now(), fragmentEmittedAt: Date.now() }
              : undefined
            this.emit('chunk', { cameraId: params.cameraId, kind: 'fragment', data: fragment, timing })
          }
        )
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (!settled && /frame=\s*\d+/.test(text)) settleSuccess()

        if (LATENCY_INSTRUMENTATION_ENABLED) {
          // showinfo lines can straddle two stderr chunks - buffer to
          // complete lines only, or a split `iskey:1` token could be missed
          // (undercounting) or double-processed (overcounting) across a
          // chunk boundary, corrupting the exact 1-keyframe-per-fragment
          // correlation the queue depends on.
          //
          // -loglevel is 'info' while instrumentation is on (see buildArgs),
          // which makes stderr far noisier than this app's normal 'warning'
          // level - one showinfo line per frame. Those lines are kept out of
          // stderrTail entirely (only real, potentially-error-relevant lines
          // go in) so isEncoderInitError's failure diagnosis still has an
          // actual error message to look at instead of per-frame noise
          // crowding it out of the last 4000 characters right when it
          // matters most, at startup.
          session.stderrLineBuffer += text
          const lines = session.stderrLineBuffer.split('\n')
          session.stderrLineBuffer = lines.pop() ?? ''
          for (const line of lines) {
            if (/\biskey:1\b/.test(line)) {
              session.pendingKeyframeTimings.push(Date.now())
            } else {
              session.stderrTail = (session.stderrTail + line + '\n').slice(-4000)
            }
          }
        } else {
          session.stderrTail = (session.stderrTail + text).slice(-4000)
        }
      })

      child.on('error', (err) => settleFailure(err.message, err.message))
      child.on('close', (code) => {
        const wasActive = this.sessions.has(params.cameraId)
        session.segmentWatcher?.close()
        if (!settled) {
          settleFailure(summarizeFfmpegError(session.stderrTail), session.stderrTail)
          return
        }
        const last = session.segments[session.segments.length - 1]
        if (last && last.closedAt === null) last.closedAt = Date.now()
        if (this.sessions.get(params.cameraId) === session) {
          this.sessions.delete(params.cameraId)
        }
        if (session.overlayTimer) clearInterval(session.overlayTimer)
        if (session.killTimer) clearTimeout(session.killTimer)
        session.stopResolvers.forEach((r) => r({ success: code === 0, error: code === 0 ? null : summarizeFfmpegError(session.stderrTail) }))
        if (wasActive) {
          this.emit('statusChanged', { cameraId: params.cameraId, active: false })
          if (session.recordingMarker) {
            logger.error('Persistent capture: ffmpeg exited unexpectedly during an active recording', {
              cameraId: params.cameraId,
              stationId: params.stationId,
              code,
              barcode: session.recordingMarker.barcode
            })
            this.emit('captureError', {
              cameraId: params.cameraId,
              stationId: params.stationId,
              message: summarizeFfmpegError(session.stderrTail)
            })
          }
        }
      })

      const graceTimer = setTimeout(settleSuccess, DEVICE_OPEN_GRACE_MS)
    })
  }

  /** Marks the start of a barcode-driven recording against whichever
   *  segment is currently being written - no ffmpeg interaction at all,
   *  just bookkeeping, which is why "Start Recording" never touches the
   *  live preview. */
  markRecordingStart(cameraId: string, barcode: string): boolean {
    const session = this.sessions.get(cameraId)
    if (!session || session.segments.length === 0) return false
    session.recordingMarker = { barcode, startedAt: Date.now(), firstSegmentIndex: session.segments.length - 1 }
    return true
  }

  /** Waits for every segment the marked recording spans to actually close
   *  (the in-progress one at "stop" time needs its own natural boundary to
   *  arrive - see SEGMENT_SECONDS), then stream-copy trims the first
   *  segment's start and the last segment's end to the exact marked
   *  boundaries and concatenates the result into `outputPath`. No frame is
   *  ever re-encoded - this is the only step "Stop Recording" actually
   *  waits on, matching the existing 'processing' status window. */
  async finalizeRecording(cameraId: string, outputPath: string): Promise<{ success: boolean; error: string | null }> {
    const session = this.sessions.get(cameraId)
    if (!session || !session.recordingMarker) {
      return { success: false, error: 'No active recording marker for this camera' }
    }
    const marker = session.recordingMarker
    const stoppedAt = Date.now()
    session.recordingMarker = null

    const deadline = Date.now() + SEGMENT_CLOSE_TIMEOUT_MS
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lastIndex = session.segments.length - 1
      if (lastIndex >= marker.firstSegmentIndex) {
        const lastCoveringSegment = session.segments.find((s) => s.openedAt <= stoppedAt && (s.closedAt === null || s.closedAt >= stoppedAt))
        if (lastCoveringSegment?.closedAt !== null && lastCoveringSegment?.closedAt !== undefined) break
        if (!lastCoveringSegment && session.segments[lastIndex].closedAt !== null) break
      }
      if (Date.now() > deadline) {
        logger.error('Persistent capture: timed out waiting for the final segment to close', { cameraId, barcode: marker.barcode })
        return { success: false, error: 'Timed out finalizing the recording segment' }
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(200)
    }

    const spanning = session.segments.filter(
      (s, i) => i >= marker.firstSegmentIndex && s.openedAt <= stoppedAt && fs.existsSync(s.path)
    )
    if (spanning.length === 0) {
      return { success: false, error: 'No captured segments found for this recording' }
    }

    const tempDir = session.segmentDir
    const workingPieces: string[] = []
    try {
      for (let i = 0; i < spanning.length; i++) {
        const seg = spanning[i]
        const isFirst = i === 0
        const isLast = i === spanning.length - 1
        if (!isFirst && !isLast) {
          workingPieces.push(seg.path)
          continue
        }

        const startOffset = isFirst ? Math.max(0, (marker.startedAt - seg.openedAt) / 1000) : 0
        const segEndAt = seg.closedAt ?? stoppedAt
        const naturalDuration = (segEndAt - seg.openedAt) / 1000
        const endOffset = isLast ? Math.max(0.05, (Math.min(stoppedAt, segEndAt) - seg.openedAt) / 1000) : naturalDuration

        if (startOffset <= 0.05 && endOffset >= naturalDuration - 0.05) {
          // The whole segment is inside the recording - no trim needed.
          workingPieces.push(seg.path)
          continue
        }

        const trimmedPath = path.join(tempDir, `trim_${i}_${path.basename(seg.path)}`)
        // eslint-disable-next-line no-await-in-loop
        await this.trimSegment(seg.path, trimmedPath, startOffset, endOffset - startOffset)
        workingPieces.push(trimmedPath)
      }

      const listPath = path.join(tempDir, `concat_${Date.now()}.txt`)
      const listContent = workingPieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
      fs.writeFileSync(listPath, listContent, 'utf-8')

      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      await this.concatCopy(listPath, outputPath)

      return { success: true, error: null }
    } catch (err) {
      const message = (err as Error).message
      logger.error('Persistent capture: failed to finalize recording from segments', { cameraId, barcode: marker.barcode, error: message })
      return { success: false, error: message }
    } finally {
      for (const piece of workingPieces) {
        if (piece.startsWith(path.join(tempDir, 'trim_'))) {
          fs.unlink(piece, () => undefined)
        }
      }
    }
  }

  private trimSegment(inputPath: string, outputPath: string, startOffset: number, duration: number): Promise<void> {
    const ffmpegPath = resolveFfmpegPath()
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-ss',
      startOffset.toFixed(3),
      '-i',
      inputPath,
      '-t',
      Math.max(0.05, duration).toFixed(3),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      '-y',
      outputPath
    ]
    return new Promise((resolve, reject) => {
      let stderr = ''
      const child = spawn(ffmpegPath, args)
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(summarizeFfmpegError(stderr)))))
    })
  }

  private concatCopy(listPath: string, outputPath: string): Promise<void> {
    const ffmpegPath = resolveFfmpegPath()
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      outputPath
    ]
    return new Promise((resolve, reject) => {
      let stderr = ''
      const child = spawn(ffmpegPath, args)
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(summarizeFfmpegError(stderr)))))
    })
  }

  /** Graceful stop for when a camera is unassigned/disconnected or the app
   *  is quitting - never called as part of a normal record/stop cycle,
   *  since recording never touches this process's lifecycle at all. */
  async stop(cameraId: string): Promise<void> {
    const session = this.sessions.get(cameraId)
    if (!session) return

    if (session.overlayTimer) {
      clearInterval(session.overlayTimer)
      session.overlayTimer = null
    }

    const result = new Promise<void>((resolve) => {
      session.stopResolvers.push(() => resolve())
    })

    try {
      session.child.stdin?.write('q')
    } catch {
      // best-effort - the force-kill timer below is the real backstop
    }
    session.killTimer = setTimeout(() => {
      if (this.sessions.has(cameraId)) session.child.kill()
    }, GRACEFUL_STOP_TIMEOUT_MS)

    await result
  }

  killAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const session of this.sessions.values()) {
      if (session.overlayTimer) clearInterval(session.overlayTimer)
      if (session.killTimer) clearTimeout(session.killTimer)
      try {
        session.child.kill()
      } catch {
        // best-effort
      }
    }
    this.sessions.clear()
  }

  private sweepOldSegments(): void {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      const earliestNeeded = session.recordingMarker
        ? session.segments[session.recordingMarker.firstSegmentIndex]?.openedAt ?? now
        : now - SEGMENT_RETENTION_MS
      for (const seg of session.segments) {
        if (seg.closedAt === null) continue
        const keepUntil = Math.max(seg.closedAt + SEGMENT_RETENTION_MS, earliestNeeded + SEGMENT_RETENTION_MS)
        if (now > keepUntil && seg.openedAt < earliestNeeded) {
          fs.unlink(seg.path, () => undefined)
        }
      }
      // Bound the in-memory segment list itself so a camera left running
      // for days doesn't grow it forever.
      if (session.segments.length > 2000) {
        session.segments.splice(0, session.segments.length - 2000)
      }
    }
  }
}

function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
}

export const persistentCaptureService = new PersistentCaptureService()
