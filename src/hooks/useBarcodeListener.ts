import { useEffect, useRef } from 'react'

const SCAN_RESET_MS = 300

/** USB barcode scanners behave like a keyboard typing very fast followed by
 *  Enter. This listens globally, buffers keystrokes, and fires onScan with
 *  the completed barcode when Enter arrives. It ignores keystrokes while the
 *  user is focused in a real text field (Settings/Search pages) so normal
 *  typing never gets misread as a scan. */
export function useBarcodeListener(onScan: (barcode: string) => void, enabled: boolean): void {
  const bufferRef = useRef('')
  const lastKeyTimeRef = useRef(0)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    if (!enabled) return

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
    }

    function handleKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target)) return

      const now = Date.now()
      if (now - lastKeyTimeRef.current > SCAN_RESET_MS) {
        bufferRef.current = ''
      }
      lastKeyTimeRef.current = now

      if (e.key === 'Enter') {
        const barcode = bufferRef.current.trim()
        bufferRef.current = ''
        if (barcode.length > 0) {
          onScanRef.current(barcode)
        }
        return
      }

      if (e.key.length === 1) {
        bufferRef.current += e.key
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled])
}
