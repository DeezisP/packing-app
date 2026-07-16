import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AnimatedButton } from '../common/AnimatedButton'
import { formatDuration } from '../../lib/format'
import { strings } from '../../lib/strings'
import type { RecordingRecord } from '../../../electron/shared/types'

interface Props {
  recording: RecordingRecord
  onClose: () => void
}

export function VideoPlayerModal({ recording, onClose }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  function logVideoState(event: string, extra?: Record<string, unknown>): void {
    const v = videoRef.current
    window.electronAPI.system.log('info', `Playback stage: video event - ${event}`, {
      recordingId: recording.id,
      barcode: recording.barcode,
      readyState: v?.readyState ?? null,
      currentSrc: v?.currentSrc ?? null,
      ...extra
    })
  }

  useEffect(() => {
    let cancelled = false

    async function preflight(): Promise<void> {
      window.electronAPI.system.log('info', 'Playback stage: initializing player', {
        recordingId: recording.id,
        barcode: recording.barcode,
        videoPath: recording.videoPath,
        generatedUrl: recording.videoUrl,
        status: recording.status
      })
      const result = await window.electronAPI.recordings.checkForPlayback(recording.videoPath)
      if (cancelled) return
      window.electronAPI.system.log('info', 'Playback stage: pre-flight file check result', {
        recordingId: recording.id,
        videoPath: recording.videoPath,
        exists: result.exists,
        readable: result.readable,
        locked: result.locked,
        sizeBytes: result.sizeBytes,
        looksLikeValidMp4: result.looksLikeValidMp4
      })
      if (result.error) {
        setPlaybackError(result.error)
      }
    }

    preflight()
    window.electronAPI.recordings.markViewed(recording.id)
    return () => {
      cancelled = true
    }
  }, [recording.id])

  function handleVideoError(): void {
    const mediaError = videoRef.current?.error
    const message = mediaError ? mediaErrorMessage(mediaError.code) : 'ไม่สามารถเล่นวิดีโอได้'
    setPlaybackError(message)
    logVideoState('error', { errorCode: mediaError?.code ?? null, errorMessage: mediaError?.message || message })
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
      if (e.key === 'ArrowRight') stepFrame(1)
      if (e.key === 'ArrowLeft') stepFrame(-1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function togglePlay(): void {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play()
    } else {
      v.pause()
    }
  }

  function stepFrame(direction: 1 | -1): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = Math.max(0, v.currentTime + direction * (1 / recording.fps))
  }

  function seek(value: number): void {
    const v = videoRef.current
    if (!v) return
    v.currentTime = value
  }

  function toggleFullscreen(): void {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current.requestFullscreen()
    }
  }

  return (
    <motion.div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={containerRef}
        className="glass glass-strong overflow-hidden w-full max-w-4xl flex flex-col"
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 10 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div>
            <p className="font-mono text-sm text-slate-200">{recording.barcode}</p>
            <p className="text-xs text-slate-500">
              {strings.videoPlayer.meta(recording.station, recording.camera, recording.resolution, recording.fps)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            {strings.common.close}
          </button>
        </div>

        <div className="relative">
          <video
            ref={videoRef}
            src={recording.videoUrl}
            className="w-full bg-black max-h-[60vh]"
            onLoadStart={() => logVideoState('loadstart')}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration)
              logVideoState('loadedmetadata', { duration: e.currentTarget.duration })
            }}
            onLoadedData={() => logVideoState('loadeddata')}
            onCanPlay={() => logVideoState('canplay')}
            onCanPlayThrough={() => logVideoState('canplaythrough')}
            onPlay={() => {
              setPlaying(true)
              logVideoState('play')
            }}
            onPlaying={() => logVideoState('playing')}
            onPause={() => {
              setPlaying(false)
              logVideoState('pause')
            }}
            onWaiting={() => logVideoState('waiting')}
            onStalled={() => logVideoState('stalled')}
            onSuspend={() => logVideoState('suspend')}
            onEnded={() => logVideoState('ended')}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onError={handleVideoError}
          />
          {playbackError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/85 text-warn-500 text-sm px-6 text-center">
              {playbackError}
            </div>
          )}
        </div>

        <div className="p-4 space-y-3">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-full accent-accent-500"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AnimatedButton size="sm" onClick={() => stepFrame(-1)} title={strings.videoPlayer.prevFrame}>
                ⏮
              </AnimatedButton>
              <AnimatedButton variant="primary" onClick={togglePlay}>
                {playing ? strings.videoPlayer.pause : strings.videoPlayer.play}
              </AnimatedButton>
              <AnimatedButton size="sm" onClick={() => stepFrame(1)} title={strings.videoPlayer.nextFrame}>
                ⏭
              </AnimatedButton>
              <span className="text-xs text-slate-500 font-mono ml-2">
                {formatDuration(currentTime)} / {formatDuration(duration || 0)}
              </span>
            </div>
            <AnimatedButton onClick={toggleFullscreen}>{strings.videoPlayer.fullscreen}</AnimatedButton>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** Maps the standard MediaError codes (https://developer.mozilla.org/docs/Web/API/MediaError/code)
 *  to a Thai message - MEDIA_ERR_SRC_NOT_SUPPORTED (4) is what a genuinely
 *  corrupt/unfinalized MP4 (no moov atom) surfaces as in Chromium. */
function mediaErrorMessage(code: number): string {
  switch (code) {
    case 1:
      return 'การเล่นวิดีโอถูกยกเลิก'
    case 2:
      return 'เกิดข้อผิดพลาดขณะโหลดไฟล์วิดีโอ'
    case 3:
      return 'ไม่สามารถถอดรหัสไฟล์วิดีโอได้ - ไฟล์อาจเสียหาย'
    case 4:
      return 'ไฟล์วิดีโอเสียหายหรือไม่สมบูรณ์ ไม่สามารถเล่นได้'
    default:
      return 'ไม่สามารถเล่นวิดีโอได้'
  }
}
