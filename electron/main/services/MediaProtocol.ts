import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'

export const MEDIA_SCHEME = 'packing-media'

// Must run before app.whenReady() - privileged schemes have to be declared
// at module load time so the renderer is allowed to fetch/stream from them.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { secure: true, standard: true, stream: true, bypassCSP: true, supportFetchAPI: true }
  }
])

/** Serves local video/thumbnail files to the renderer without relying on
 *  raw file:// access, which Electron blocks/CORS-restricts inconsistently
 *  between the dev server origin and the packaged file:// origin. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    // Strip any query string before decoding the path - callers polling a
    // continuously-overwritten file (see the live recording-preview frame)
    // append a cache-busting `?t=...` to force a fresh read past any HTTP
    // caching, which must never become part of the file path itself.
    const withoutScheme = request.url.replace(`${MEDIA_SCHEME}://`, '').split('?')[0]
    const absolutePath = decodeURIComponent(withoutScheme)
    return net.fetch(pathToFileURL(absolutePath).toString())
  })
}

export function toMediaUrl(absolutePath: string): string {
  return `${MEDIA_SCHEME}://${encodeURIComponent(absolutePath)}`
}
