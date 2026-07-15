import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { autoUpdater } from 'electron-updater'
import { logger } from './Logger'
import type { UpdateState } from '@shared/types'

/** Thin wrapper around electron-updater, itself pointed at GitHub Releases
 *  via the `publish` block in electron-builder.yml. Downloads are only ever
 *  started when the operator explicitly clicks "Download & Install" (never
 *  automatically), and installing always happens through quitAndInstall()
 *  after that same confirmation, so nothing changes underfoot mid-shift. */
class UpdateService extends EventEmitter {
  private state: UpdateState = {
    status: 'idle',
    currentVersion: app.getVersion(),
    latestVersion: null,
    releaseNotes: null,
    progressPercent: null,
    error: null
  }
  private initialized = false

  init(): void {
    if (this.initialized) return
    this.initialized = true

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking', error: null })
    })

    autoUpdater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        latestVersion: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        error: null
      })
      logger.info('Update available', { version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      this.setState({ status: 'not-available', latestVersion: null, error: null })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.setState({ status: 'downloading', progressPercent: Math.round(progress.percent) })
    })

    autoUpdater.on('update-downloaded', () => {
      this.setState({ status: 'downloaded', progressPercent: 100 })
      logger.info('Update downloaded, ready to install')
    })

    autoUpdater.on('error', (err) => {
      this.setState({ status: 'error', error: friendlyErrorMessage(err) })
      logger.error('Auto-update error', { error: err.message })
    })
  }

  private setState(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial }
    this.emit('stateChanged', this.state)
  }

  getState(): UpdateState {
    return this.state
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      this.setState({
        status: 'error',
        error: 'Updates are only available in an installed build, not in development mode.'
      })
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.setState({ status: 'error', error: friendlyErrorMessage(err as Error) })
      logger.error('checkForUpdates failed', { error: (err as Error).message })
    }
  }

  async download(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.setState({ status: 'error', error: 'Download failed. Please try again.' })
      logger.error('downloadUpdate failed', { error: (err as Error).message })
    }
  }

  quitAndInstall(): void {
    logger.info('Installing update and restarting application')
    autoUpdater.quitAndInstall()
  }
}

function friendlyErrorMessage(err: Error): string {
  const message = err.message ?? String(err)
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|404/i.test(message)) {
    return 'Unable to check for updates. Please try again later.'
  }
  if (/app-update\.yml/i.test(message)) {
    return 'Update metadata not found. This build was not installed via the NSIS installer, so it cannot self-update.'
  }
  return message
}

function normalizeReleaseNotes(notes: unknown): string | null {
  if (!notes) return null
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => (entry && typeof entry === 'object' && 'note' in entry ? String((entry as { note?: string }).note ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return null
}

export const updateService = new UpdateService()
