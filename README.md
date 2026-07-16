# PackingRecorder

A fully offline Windows desktop application for recording packing videos using USB barcode
scanners and USB webcams. Everything - the UI, the SQLite database, FFmpeg, and the recorded
videos - runs and lives inside this one folder. No server, no cloud, no internet connection
required at any point.

The interface is a fully Thai-language, Apple-inspired frosted-glass UI (blurred translucent
panels, soft shadows, smooth animated transitions throughout) built on a small reusable design
system (`GlassPanel`, `AnimatedButton`, `AnimatedDialog`, `NotificationToast`, `StationCard`,
`DeviceStatus`, `CameraPreview`, `RecordingStatus`), and the Dashboard supports any number of
packing stations - 1, 2, 12, or more - reflowing its grid automatically instead of assuming a
fixed count.

## How it works

1. The app opens showing **Waiting for barcode...** for every configured packing station.
2. Scan a barcode (the scanner types it like a keyboard, then presses Enter) at the **active
   station** - recording starts immediately with no clicks or dialogs.
3. Scan the **same** barcode again to stop and save the recording to
   `Videos/<barcode>/packing.mp4` (plus a `thumbnail.jpg` and a `metadata.json`).
4. Scanning a **different** barcode while a station is recording is rejected with a
   "Wrong barcode" notice; the active recording is never interrupted.
5. Scanning a barcode that already has a folder on disk prompts **Recording already exists -
   Open folder?** and never overwrites anything.

### Multiple stations & scanner routing

Every packing station (Dashboard card) has its own independent camera, timer, and recording
process - any number of stations can record different barcodes at the same time without
interfering with each other. The Dashboard grid is fully dynamic (`repeat(auto-fit, minmax(...))`)
and reflows on its own as stations are added, removed, resized, or the window is resized - there
is no hardcoded two-station layout anywhere in the app.

Windows normally can't tell two "keyboard-emulating" USB barcode scanners apart - they all show up
as generic HID keyboards, and by the time a keystroke reaches a browser/Electron window it has
already lost any notion of which physical device sent it. PackingRecorder works around that using
**Windows Raw Input** (`WM_INPUT`) to identify individual HID devices at the OS level - see
"Device Pairing" below. A scan from a scanner paired to a station routes straight there
automatically, regardless of which station is currently "active." Any station without a paired
scanner (or if Raw Input can't be used for some reason - see Known limitations) falls back to the
**active station selector**: click a card (or press `1`-`9`, which reaches the first nine enabled
stations - click still works for any station beyond that) to make it active, then the next scan
anywhere routes there.

Scanner and camera are both plain fields on the same station record (`scannerDeviceId`, `cameraId`)
- there's no separate mapping table to keep in sync, so a scan's route to "the right camera" is
always: physical scanner → the one station with that `scannerDeviceId` → that station's `cameraId`.
Assigning a camera to a station in Settings automatically un-assigns it from wherever it was before
(the same way pairing a scanner to a station in Device Pairing already did), so the same physical
camera can never end up wired to two stations at once. If a config still ends up with a station
missing a scanner/camera, or two stations pointing at the same one (e.g. hand-edited config.json),
a warning banner - checked on startup and kept live as devices and config change - names exactly
which stations and which problem, app-wide, not just on the page where you'd go to fix it.

### Managing packing stations

Settings → **Packing Stations** manages the full list:

- **+ Add station** creates a new one; each card can be **renamed** inline.
- **▲ / ▼** reorders stations - the order shown here is the order they appear on the Dashboard.
- The enable toggle on each card **disables** a station without deleting its configuration: a
  disabled station disappears from the Dashboard, never accepts scans, and can be re-enabled later
  with all its settings (camera, scanner pairing, resolution, etc.) intact.
- Camera, microphone, resolution, FPS, and bitrate are configured per station, same as before.
- **Save location** can either inherit the app-wide folder (Settings → General) or be overridden
  per station - useful when different stations should write to different drives/shares.

A config upgrading from an older version that has no `enabled`/`saveLocationOverride` fields yet is
normalized on load (`enabled` defaults to `true`, save location defaults to inherit-global), so
existing stations never disappear or misconfigure themselves after an update.

### Multiple identical cameras

Two USB webcams of the exact same model report the exact same DirectShow friendly name (e.g. two
"EMEET SmartCam S600" units) - Windows can tell them apart, and so can PackingRecorder, by their
DirectShow device path instead of that name. Every camera picker (Settings, Device Pairing,
Dashboard preview) shows duplicates suffixed for clarity - "EMEET SmartCam S600 (1)",
"EMEET SmartCam S600 (2)" - and internally matches, previews, pairs, and **records** each one by
its unique device path, never by the shared name, so two identical cameras can be assigned to two
different stations and record simultaneously without conflict.

Camera enumeration works by asking ffmpeg to list DirectShow devices and parsing its text output -
that parser reads the type (camera vs. microphone) of each line from ffmpeg's own inline
`(video)`/`(audio)` tag, falling back to older ffmpeg's section-header format for a build that
predates the inline tag. (An earlier version of this parser only understood the header format;
current ffmpeg builds don't print one, which silently dropped every camera - not just duplicates -
until it was fixed.)

Settings → **Diagnostics** cross-references three independent detection sources side by side -
Chromium's own `navigator.mediaDevices`, ffmpeg/DirectShow, and Windows' PnP device database
(`Get-PnpDevice`) - so a mismatch between what's actually connected and what any one layer reports
is visible directly. It also lists every detected camera's unique id and station assignment, offers
a real live-preview test and a real short test recording per camera, and an **Export Diagnostics**
button that writes a `diagnostics.txt` with all of the above plus recent app logs, for
troubleshooting on-site without a debugger attached.

The live **preview** (Settings/Device Pairing "Test Camera", and the Dashboard station feed) still
goes through Chromium's `getUserMedia`, not ffmpeg - Chromium and ffmpeg are two separate device
namespaces with no shared id, so the preview has to correlate a station's ffmpeg device path to a
Chromium `deviceId` by matching device labels. Two things had to be true for that correlation to
work at all, and both were silently broken: Chromium redacts every device's label until the current
window has completed one actually-granted `getUserMedia()` call (an Electron
`setPermissionRequestHandler` alone does not unlock this - `setPermissionCheckHandler` is also
required, and even then the first call in a fresh window still needs a one-time unconstrained
priming call before labels appear), and once labels ARE visible, Chromium appends a
`" (vendorId:productId)"` suffix to a camera's label whenever more than one device shares a name -
so a strict equality check against ffmpeg's plain friendly name never matched anything. With zero
label matches, every "Test Camera" click silently fell back to an unconstrained `getUserMedia`
request, which opens whatever Chromium considers the default device - the same physical camera -
regardless of which one was actually requested. Recording was never affected by any of this: it
opens a camera by ffmpeg's own unique DirectShow device path directly and has no dependency on
Chromium's device list.

## Device Pairing

Open the **Device Pairing** tab to identify physical scanners individually and assign each one to
a station:

1. Click **+ Identify Scanner**, then scan any barcode on the physical scanner you want to add.
   PackingRecorder detects which physical USB device that scan came from (via Raw Input, not just
   "a keystroke happened") and prompts you to name it - e.g. "Packing Table 1", "Left Scanner".
   Scanning again on an already-identified scanner lets you rename it instead of adding a
   duplicate.
2. Each identified scanner shows as a card with its name, live Connected/Disconnected status, and
   a dropdown to assign it to a station. The underlying Windows device path is hidden by default -
   click **Advanced** on a card to see it (useful for troubleshooting, never needed day-to-day).
3. The **Cameras** section lists every detected webcam with a **Test Camera** button that opens a
   live preview - handy for confirming you've got the right camera before assigning it to a
   station in Settings.

Only scanners you've explicitly identified this way ever appear here - other HID devices (mice,
headsets, webcam volume controls, etc.) are never shown, even though Windows reports all of them
under similar device classes internally.

Pairings are stored in `config.json` under `identifiedScanners` (id + your chosen name) and each
station's `scannerDeviceId` (which scanner, if any, is assigned to it) - both update immediately,
no manual file editing needed, and changes apply without restarting the app.

**Survives updates and reinstalls**: every time settings change, the same config is also mirrored
to a backup copy in the OS-managed per-user data folder (outside the app's own install directory,
which is the only place NSIS install/update/uninstall ever touches). If `config.json` is ever
found missing or unreadable at startup - including after an app update - it's restored from that
backup automatically before anything else loads, so paired scanners, station setup, and every
other setting survive intact. This is a defense-in-depth safeguard on top of NSIS's own default
behavior, which already leaves files it didn't ship (like `config.json`) alone.

If a paired scanner or camera disconnects, only *that station* shows a warning - the other
stations keep recording and operating normally. A station with a disconnected scanner can still be
operated via the active-station selector in the meantime.

## Recording Overlay

Every recording can burn a plain-text information overlay directly into the video frames - not a
UI-only annotation, it's permanently part of the exported MP4. Configure it in **Settings →
Recording Overlay**:

- Toggle the whole overlay on/off, and each line independently: Barcode, Date, Time, Recording
  Timer, Packing Station, Camera Name.
- Position (Top Left/Top Right/Bottom Left/Bottom Right), font size, font color, background color,
  and background opacity are all configurable, with a live preview shown right there in Settings.
- The same preview also appears live over each station's camera feed on the Dashboard, so what you
  see while packing is what actually gets recorded.

Example (default layout - top-left, white text, semi-transparent black background):

```
Order: ORD240715001
Date: 2026-07-15
Time: 14:36:18
Recording: 00:02:45
Station: Packing Station 1
Camera: EMEET S600 #1
```

**How it's rendered:** ffmpeg's `drawtext` filter burns the text into the video during the same
encode pass that's already happening (not a separate re-encode step), using a small text file that
gets rewritten once a second while recording - `Time` and `Recording` update continuously and stay
exactly in sync with the video itself, since the elapsed-time value comes from the same clock the
Dashboard timer uses. Font rendering uses Windows' bundled Arial with libfreetype (anti-aliased,
sans-serif, present on every Windows install - no font files to bundle). Refreshing that text file
once a second adds negligible overhead to an already-running x264 encode; it does not introduce
dropped frames or measurably affect recording performance.

Existing recordings are never touched - this only affects new recordings made after you change a
setting, and disabling the overlay entirely skips the filter altogether (zero overhead, same
pipeline as before this feature existed).

## Recording metadata (metadata.json)

Alongside `packing.mp4` and `thumbnail.jpg`, every completed recording also gets a `metadata.json`
in its folder - a plain-file companion to the database record, useful if you ever need to process
the `Videos/` folder directly without going through the app:

```json
{
  "barcode": "ORD240715001",
  "station": "Packing Station 1",
  "camera": "EMEET S600 #1",
  "startTime": "2026-07-15T14:36:18.000Z",
  "endTime": "2026-07-15T14:39:02.000Z",
  "duration": "00:02:44",
  "resolution": "1920x1080",
  "fps": 30,
  "fileSize": 245678901
}
```

## Technology

Electron + React + TypeScript + Tailwind CSS + [Framer Motion](https://www.framer.com/motion/)
(page/dialog/list animations) + SQLite (`sql.js`, a pure WebAssembly build - no native compilation
required) + FFmpeg (`ffmpeg-static`, bundled) + [`koffi`](https://koffi.dev) (a prebuilt-binary FFI
library used only for the handful of `user32.dll` Raw Input calls behind Device Pairing - no
native compilation needed there either) + electron-builder. No Express, no Next.js, no Docker, no
cloud services - everything ships and runs inside this folder.

All UI text is in Thai (`src/lib/strings.ts` is the single source of truth for every string in the
app - there is no language switcher; it is Thai-only by design).

## Folder structure

```
PackingRecorder/
  electron/
    main/            Main process: services (config, db, camera, scanner, raw input, recording,
                     logging), IPC, windows
    preload/          contextBridge API exposed to the renderer
    shared/            Types & IPC channel names shared by main + renderer
  src/                 React renderer (Dashboard, Search, Device Pairing, Settings, video player)
  public/              Static assets copied as-is into the renderer build
  build/
    icon.ico             App icon used by electron-builder (installer, .exe, Start Menu/Desktop
                          shortcuts) - see "App icon / branding" below
  resources/
    icon.ico             Same icon, shipped as a runtime resource for the window/taskbar icon
  database/
    schema.sql         Reference copy of the SQLite schema (also embedded in Database.ts)
  Videos/               Recorded packing videos (Videos/<barcode>/packing.mp4 + thumbnail.jpg +
                        metadata.json)
  Logs/                 Rotating app.log / error.log
  config.json           Runtime settings (created on first launch from config.default.json)
  database.sqlite       Recording history
  package.json
  electron.vite.config.ts
  electron-builder.yml
```

`Videos/`, `Logs/`, `config.json` and `database.sqlite` are created next to the app automatically
on first launch (in dev: the project root; in a packaged build: the folder the installed `.exe`
lives in), so copying the whole `PackingRecorder` folder to another Windows PC brings every
setting and every recording with it.

## Requirements

- Windows 10/11 (uses DirectShow via ffmpeg for webcam capture)
- [Node.js](https://nodejs.org) 18 or newer

No C++ build tools or Python are required - every dependency (including SQLite via `sql.js`, and
FFmpeg via a bundled prebuilt binary) is either pure JavaScript/WebAssembly or ships as a
ready-to-run binary, so `npm install` never needs to compile a native module.

## Setup

```powershell
npm install
npm run dev
```

`npm run dev` launches the app in development mode with hot reload for the renderer.

## Building the Windows installer

```powershell
npm run dist
```

This runs `electron-vite build` followed by `electron-builder`, producing (inside `release/`):

- `PackingRecorder-Setup-<version>.exe` - the NSIS installer clients run
- `PackingRecorder-Setup-<version>.exe.blockmap` - used by electron-updater for differential
  (partial) downloads of future updates
- `latest.yml` - the GitHub Releases update-metadata file electron-updater checks against

All three files are what you upload to a GitHub Release (see "Publishing a new version" below) -
`npm run dist` never publishes anything by itself (`--publish never`). Run `npm run dist:dir`
instead if you just want an unpacked `release/win-unpacked/PackingRecorder.exe` for a quick local
smoke test (auto-update does not work from this unpacked form - only the installed app has the
`app-update.yml` electron-updater needs).

## App icon / branding

The app icon (window/taskbar icon, installer icon, uninstaller icon, Start Menu and Desktop
shortcuts) is `build/icon.ico`, referenced explicitly in `electron-builder.yml` (`win.icon`,
`nsis.installerIcon`, `nsis.uninstallerIcon`, `nsis.installerHeaderIcon`) so it's always used
instead of the generic default Electron icon. The same image is also copied to
`resources/icon.ico` and shipped as a runtime resource (see `PathService.ts`'s `iconFile`) so the
window carries the custom icon even when just running `npm run dev`, not only in a packaged build.

To change it, replace both `build/icon.ico` and `resources/icon.ico` with a new multi-resolution
`.ico` (containing at least 16x16, 32x32, and 48x48 sizes) generated from your source image - a
square PNG works well as the source. One way to regenerate it without any GUI tool:

```powershell
npm install --no-save png-to-ico
node -e "const p=require('png-to-ico');const fs=require('fs');p('path/to/logo.png').then(b=>{fs.writeFileSync('build/icon.ico',b);fs.copyFileSync('build/icon.ico','resources/icon.ico')})"
```

Then rebuild (`npm run dist` or `npm run dev`) - no other code changes are needed.

## Settings

Open the **Settings** tab to configure, per packing station: enabled/disabled, camera, microphone
(optional audio), resolution (720p/1080p/1440p/4K), FPS, bitrate, and save location (global or
per-station override) - see "Managing packing stations" above - plus the app-wide save location,
theme, Windows auto-start, database backups, and updates. Everything is written straight to
`config.json` as soon as you interact with a control - there is no separate "Save" step, except for
the app-wide save location (see below), which requires an explicit Apply/Browse action since it is
validated first.

## Changing the recording save location

Settings → General → **Current save location** lets you point new recordings at any writable
folder, not just the bundled `Videos/` folder:

- **Browse...** opens the native Windows folder picker (can also create a new folder from inside
  the dialog).
- Typing a path directly and pressing **Apply** (or Enter) validates it first. If the folder
  doesn't exist yet, you'll be asked **"Folder does not exist. Create it?"** - it is never created
  silently.
- The status line under the field shows whether the folder exists, is actually writable (verified
  with a real write-test, not just a permissions check), and how much free space is left on that
  drive.
- **Reset to default** puts it back to the bundled `Videos/` folder.

This is stored in `config.json` as `saveLocation` (relative paths resolve against the app's own
folder; absolute paths like `D:\PackingVideos` are used as-is):

```json
{
  "saveLocation": "D:\\PackingVideos"
}
```

Changing it takes effect immediately for the **next** recording - no restart needed. Recordings
already on disk keep their original absolute path in the database, so switching folders never
moves, breaks, or re-points existing recordings; the Search tab keeps finding them exactly where
they were saved.

If the configured folder later becomes unavailable (network share dropped, drive unplugged,
permissions changed), a red banner appears across every tab and new recordings are refused with a
clear error until a valid folder is set again - existing recordings and the app itself are
unaffected.

## Auto-updates from GitHub Releases

PackingRecorder updates itself via [`electron-updater`](https://www.electron.build/auto-update),
pointed at this repository's GitHub Releases
(`https://github.com/DeezisP/packing-app`) - there is no custom update server. The version
compared is always read from `package.json` (`app.getVersion()`); it is never hardcoded anywhere.

**Where to find it in the app:**

- **Settings → Updates** - shows Current Version, Latest Version, a Check for Updates button, and
  (once a check has run) either "You are using the latest version" or the available version with
  its release notes.
- **Dashboard** - an "Update available" badge appears automatically once an update is found (the
  app also checks once, silently, ~8 seconds after launch). Clicking it reopens the same
  confirmation dialog if you previously dismissed it with "Later".
- **Menu → Check for Updates** - press <kbd>Alt</kbd> to reveal the menu bar (it auto-hides during
  normal barcode-scanning use), then PackingRecorder → Check for Updates.

**How installing works:** nothing downloads automatically. Checking only tells you a version is
available; clicking **Download & Install** downloads it in the background with a visible progress
bar, and only once that finishes are you asked to restart - clicking **Restart & Install** quits,
installs, and relaunches the app on the new version completely silently (no installer window,
no wizard - the app just briefly closes and reopens). Declining ("Later") leaves the running app
completely untouched.

Updates only work in an **installed** build (the NSIS installer output), because that's the only
form that carries the `app-update.yml` electron-updater reads at runtime. Running from `npm run
dev` or a `--dir` build shows a clear "not available in development mode" / "not installed via the
NSIS installer" message instead of failing silently. If GitHub itself is unreachable, you'll see
"Unable to check for updates. Please try again later." with the option to retry.

### Publishing a new version (maintainers)

1. Bump `"version"` in `package.json` (e.g. `1.0.0` → `1.1.0`). This is the single source of truth
   for the version electron-updater compares against - nothing else needs editing.
2. Build and publish directly to GitHub in one step. This requires a personal access token with
   write access to Releases on this repo:

   - **Fine-grained token** (github.com/settings/personal-access-tokens/new, recommended): set
     Repository access to this repo, then under Permissions → Repository permissions set
     **Contents: Read and write**. This is the permission that actually covers creating releases -
     GitHub's 403 error on a missing/wrong permission here reads
     `Resource not accessible by personal access token`, which is easy to mistake for an auth
     problem instead of a missing-permission one.
   - **Classic token** (github.com/settings/tokens/new): just check the **`repo`** scope.

   Two ways to provide whichever token you generate, pick whichever fits your workflow:

   - **`.env` file (persists locally, never committed)** - copy `.env.example` to `.env` and fill
     in `GH_TOKEN=<your token>`. `.env` is gitignored, so it never leaves your machine. Then just:

     ```powershell
     npm run release
     ```

     `npm run release` loads `.env` automatically via `dotenv-cli` before running
     `electron-builder`.

   - **Shell environment variable (one-off, nothing written to disk)**:

     ```powershell
     $env:GH_TOKEN = "<your token>"
     npm run release
     ```

     A shell-level `$env:GH_TOKEN` takes precedence over `.env` if both are set.

   Either way this runs `electron-builder --win --publish always`, which builds the installer and
   uploads `PackingRecorder-Setup-<version>.exe`, its `.blockmap`, and `latest.yml` straight to a
   new **draft** GitHub Release matching the `package.json` version. Open the draft on GitHub, add
   release notes (they show up verbatim in the app's Settings → Updates panel), and publish it.

3. **Or**, if you'd rather not hand out a token on a build machine: run `npm run dist` locally,
   then manually create a GitHub Release (tag `v<version>`) and upload the three files from
   `release/` (`PackingRecorder-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`) as release
   assets yourself.

Either way, once the release is published (not left as a draft), every installed copy of
PackingRecorder will offer it as an update the next time it checks.

## Logging & recovery

- `Logs/app.log` and `Logs/error.log` rotate automatically once they pass 5MB (keeping the last 5
  rotations).
- If the app is killed mid-recording (crash, power loss), the next launch marks any recording
  still flagged `recording` in the database as `interrupted` instead of silently pretending it
  finished, so nothing is misreported as a good take.
- If free disk space drops below 500MB, any active recording is stopped safely (ffmpeg is asked
  to finalize the file, not killed) rather than risking a corrupt video.
- Cameras are polled every 5 seconds; a station whose assigned camera disappears shows a
  "Camera disconnected" badge and automatically clears once it's detected again.

## Known limitations

- **Raw Input scanner identification is Windows-only** and requires the `RegisterRawInputDevices`
  call to succeed at startup - it does on any normal desktop session. If it ever fails (e.g. a
  heavily locked-down environment), Device Pairing's Identify Scanner will report "could not
  detect which physical scanner sent that scan" and every station simply falls back to the
  active-station selector, exactly as if no scanner had been paired - recording is never blocked
  by this.
- **Light theme** is a functional but minimal palette swap (Settings → Theme); the app is
  designed dark-first. Both themes render the same frosted-glass design system.
- **Number-key hotkeys** (`1`-`9`) can only reach the first nine *enabled* stations, since there's
  only one digit per key - clicking a station card always works regardless of how many stations
  are configured.
- **UI language**: the app is Thai-only; there is no in-app language switcher.
- **Code signing**: the installer is not code-signed. Windows SmartScreen may warn on first
  install ("Windows protected your PC") - this is expected for an unsigned binary and does not
  affect auto-updates, which are integrity-checked via the sha512 hash in `latest.yml` regardless
  of signing.

## Verifying your setup

After `npm run dev` (or launching the built app), the Dashboard should immediately show your
configured stations as "Waiting", and the bottom panel should show real disk free space/total for
your save location within a couple of seconds - if it stays blank, check `Logs/error.log` (or
`Logs/app.log`, which also captures renderer-side errors) first.

## Troubleshooting

- **No cameras appear in Settings**: make sure the webcam isn't already in use by another
  application (Windows only allows one DirectShow client at a time on most drivers), then reopen
  Settings to re-scan.
- **Recording never starts**: check `Logs/error.log` - the most common cause is no camera assigned
  to that station yet (Settings → Packing Stations).
