import { buildOverlayLines } from '../../electron/shared/types'
import type { OverlayConfig, OverlayFieldData } from '../../electron/shared/types'

const MARGIN = 20
const BOX_PADDING = 8

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) || 0
  const g = parseInt(clean.slice(2, 4), 16) || 0
  const b = parseInt(clean.slice(4, 6), 16) || 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Burns the overlay text directly into a canvas frame during live capture -
 *  see useRecordingCapture.ts. Ports the literal-pixel positioning logic
 *  RecordingEngine's ffmpeg drawtext filter used to apply (margin=20,
 *  fontSize as a literal px value against the actual output resolution) -
 *  deliberately NOT OverlayPreview.tsx's container-relative `cqw` scaling,
 *  which is a separate, independent implementation for on-screen WYSIWYG
 *  display only. The canvas this draws onto is sized to the actual output
 *  resolution, so this matches what used to be burned in by ffmpeg. */
export function drawOverlayOnCanvas(ctx: CanvasRenderingContext2D, config: OverlayConfig, data: OverlayFieldData): void {
  const lines = buildOverlayLines(config, data)
  if (lines.length === 0) return

  const width = ctx.canvas.width
  const height = ctx.canvas.height

  const fontSize = config.fontSize
  const lineSpacing = Math.max(2, Math.round(fontSize * 0.3))
  const lineHeight = fontSize + lineSpacing

  ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`
  ctx.textBaseline = 'top'

  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width))
  const textHeight = lines.length * lineHeight - lineSpacing
  const boxWidth = textWidth + BOX_PADDING * 2
  const boxHeight = textHeight + BOX_PADDING * 2

  let boxX: number
  let boxY: number
  switch (config.position) {
    case 'top-left':
      boxX = MARGIN
      boxY = MARGIN
      break
    case 'top-right':
      boxX = width - boxWidth - MARGIN
      boxY = MARGIN
      break
    case 'bottom-left':
      boxX = MARGIN
      boxY = height - boxHeight - MARGIN
      break
    case 'bottom-right':
      boxX = width - boxWidth - MARGIN
      boxY = height - boxHeight - MARGIN
      break
  }

  ctx.fillStyle = hexToRgba(config.backgroundColor, config.backgroundOpacity / 100)
  ctx.fillRect(boxX, boxY, boxWidth, boxHeight)

  ctx.fillStyle = config.fontColor
  lines.forEach((line, i) => {
    ctx.fillText(line, boxX + BOX_PADDING, boxY + BOX_PADDING + i * lineHeight)
  })
}
