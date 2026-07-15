# PackingRecorder

A fully offline Windows desktop application for recording packing videos using USB barcode
scanners and USB webcams. Everything - the UI, the SQLite database, FFmpeg, and the recorded
videos - runs and lives inside this one folder. No server, no cloud, no internet connection
required at any point.

## How it works

1. The app opens showing **Waiting for barcode...** for every configured packing station.
2. Scan a barcode (the scanner types it like a keyboard, then presses Enter) at the **active
   station** - recording starts immediately with no clicks or dialogs.
3. Scan the **same** barcode again to stop and save the recording to
   `Videos/<barcode>/packing.mp4` (plus a `thumbnail.jpg`).
4. Scanning a **different** barcode while a station is recording is rejected with a
   "Wrong barcode" notice; the active recording is never interrupted.
5. Scanning a barcode that already has a folder on disk prompts **Recording already exists -
   Open folder?** and never overwrites anything.

### Multiple stations & scanner routing

Every packing station (Dashboard panel) has its own independent camera, timer, and recording
process - Station A and Station B can record two different barcodes at the same time without
interfering with each other.

Windows cannot reliably tell two "keyboard-emulating" USB barcode scanners apart from application
code (they all show up as generic HID keyboards). Because of that, PackingRecorder uses the
approach the spec explicitly allows as a fallback: an **active station selector**. Click a
station panel (or press `1`-`9`) to make it active; the next barcode scanned anywhere on the
keyboard is routed to that station. `StationConfig.scannerDeviceId` in `config.json` is kept as a
free-text field if you want to note which physical scanner belongs to which station for your own
records.

## Technology

Electron + React + TypeScript + Tailwind CSS + SQLite (`sql.js`, a pure WebAssembly build - no
native compilation required) + FFmpeg (`ffmpeg-static`, bundled) + electron-builder. No Express,
no Next.js, no Docker, no cloud services - everything ships and runs inside this folder.

## Folder structure

```
PackingRecorder/
  electron/
    main/            Main process: services (config, db, camera, recording, logging), IPC, windows
    preload/          contextBridge API exposed to the renderer
    shared/            Types & IPC channel names shared by main + renderer
  src/                 React renderer (Dashboard, Search, Settings, video player)
  public/              Static assets copied as-is into the renderer build
  database/
    schema.sql         Reference copy of the SQLite schema (also embedded in Database.ts)
  Videos/               Recorded packing videos (Videos/<barcode>/packing.mp4 + thumbnail.jpg)
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

## Settings

Open the **Settings** tab to configure, per packing station: camera, microphone (optional audio),
resolution (720p/1080p/1440p/4K), FPS, and bitrate, plus the save location, theme, Windows
auto-start, database backups, and updates. Everything is written straight to `config.json` as soon
as you interact with a control - there is no separate "Save" step, except for the save location
(see below), which requires an explicit Apply/Browse action since it is validated first.

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
bar, and only once that finishes are you asked to restart - clicking **Restart & Install** quits
and relaunches the app on the new version. Declining ("Later") leaves the running app completely
untouched.

Updates only work in an **installed** build (the NSIS installer output), because that's the only
form that carries the `app-update.yml` electron-updater reads at runtime. Running from `npm run
dev` or a `--dir` build shows a clear "not available in development mode" / "not installed via the
NSIS installer" message instead of failing silently. If GitHub itself is unreachable, you'll see
"Unable to check for updates. Please try again later." with the option to retry.

### Publishing a new version (maintainers)

1. Bump `"version"` in `package.json` (e.g. `1.0.0` → `1.1.0`). This is the single source of truth
   for the version electron-updater compares against - nothing else needs editing.
2. Build and publish directly to GitHub in one step (requires a
   [GitHub personal access token](https://github.com/settings/tokens) with `repo` scope). Two ways
   to provide it, pick whichever fits your workflow:

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

- **Per-scanner routing** is not implemented at the OS/HID level (see "Scanner routing" above) -
  the active-station selector is used instead, exactly as the spec allows as a fallback.
- **Light theme** is a functional but minimal palette swap (Settings → Theme); the app is
  designed dark-first.
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
