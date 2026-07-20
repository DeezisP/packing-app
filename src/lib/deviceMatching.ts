/** Chromium's device label is not always exactly the DirectShow/OS-reported
 *  friendly name: once it can see there are multiple devices sharing a name,
 *  it appends a `" (vendorId:productId)"` suffix to help JS-side
 *  disambiguation, e.g. ffmpeg's `"EMEET SmartCam S600"` shows up from
 *  Chromium as `"EMEET SmartCam S600 (328f:00e6)"`. A strict `===` against
 *  the plain configured name therefore matches nothing at all (confirmed via
 *  this app's own diagnostic logging: chromiumMatchCount stayed 0 even after
 *  labels were unlocked) - and both identical-model devices get the *same*
 *  suffix (same vendor/product id), so it doesn't finish the disambiguation
 *  by itself either. Matching on a name-boundary prefix handles both: it
 *  still requires the base name to match exactly (not just contain it
 *  anywhere), so it can't accidentally match an unrelated device whose name
 *  happens to start the same way. Used by useCameraPreview's getUserMedia
 *  fallback path (a camera with no active persistent capture session, e.g.
 *  a spare one being tested in Settings), which goes through Chromium's
 *  getUserMedia and so faces this label quirk directly - camera resolution
 *  for a persistently-captured camera goes through ffmpeg's own dshow
 *  device listing instead (see PersistentCaptureService), which has no
 *  equivalent mismatch to work around. */
export function labelMatchesDeviceName(label: string, name: string): boolean {
  return label === name || label.startsWith(`${name} (`)
}
