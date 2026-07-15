import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { defaultPaths, resolveSaveLocation } from './PathService'
import { logger } from './Logger'
import type { AppConfig, StationConfig } from '@shared/types'

class ConfigManager extends EventEmitter {
  private config: AppConfig
  private defaults: AppConfig

  constructor() {
    super()
    this.defaults = this.readDefault()
    this.config = this.load()
  }

  private readDefault(): AppConfig {
    const raw = fs.readFileSync(defaultPaths.configDefaultFile, 'utf-8')
    return JSON.parse(raw) as AppConfig
  }

  private load(): AppConfig {
    const fallback = this.defaults
    const primary = this.readConfigFile(defaultPaths.configFile)
    if (primary) {
      const merged = this.mergeWithDefaults(primary, fallback)
      // Seed/refresh the backup on every normal launch too, not just when a
      // setting changes, so a backup exists from the very first run.
      this.writeConfigFiles(merged)
      return merged
    }

    // Primary is missing or unreadable (e.g. an update process touched the
    // install folder unexpectedly) - fall back to the userData backup so
    // paired scanners, stations, and every other setting survive instead of
    // silently resetting to bare defaults.
    const backup = this.readConfigFile(defaultPaths.configBackupFile)
    if (backup) {
      logger.warn('config.json missing or unreadable - restored from backup', {
        backup: defaultPaths.configBackupFile
      })
      const restored = this.mergeWithDefaults(backup, fallback)
      this.writeConfigFiles(restored)
      return restored
    }

    this.writeConfigFiles(fallback)
    return fallback
  }

  private readConfigFile(filePath: string): Partial<AppConfig> | null {
    if (!fs.existsSync(filePath)) return null
    try {
      // Strip a leading UTF-8 BOM - this app never writes one, but some
      // Windows editors/tools do when a file gets hand-edited, and a BOM
      // makes JSON.parse throw on an otherwise perfectly valid file. Checked
      // via char code (0xFEFF) rather than a literal character in source to
      // avoid any editor/encoding ambiguity around invisible characters.
      let raw = fs.readFileSync(filePath, 'utf-8')
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
      return JSON.parse(raw) as Partial<AppConfig>
    } catch (err) {
      logger.error('Failed to parse config file', { filePath, error: (err as Error).message })
      return null
    }
  }

  // Shallow-merge so new fields introduced by app updates get sane defaults.
  private mergeWithDefaults(parsed: Partial<AppConfig>, fallback: AppConfig): AppConfig {
    const stations = parsed.stations?.length ? parsed.stations : fallback.stations
    return { ...fallback, ...parsed, stations: stations.map(normalizeStation) }
  }

  private persist(): void {
    this.writeConfigFiles(this.config)
  }

  private writeConfigFiles(config: AppConfig): void {
    const json = JSON.stringify(config, null, 2)
    fs.writeFileSync(defaultPaths.configFile, json)
    try {
      fs.mkdirSync(path.dirname(defaultPaths.configBackupFile), { recursive: true })
      fs.writeFileSync(defaultPaths.configBackupFile, json)
    } catch (err) {
      logger.error('Failed to write config backup', { error: (err as Error).message })
    }
  }

  get(): AppConfig {
    return this.config
  }

  getResolvedSaveLocation(): string {
    return resolveSaveLocation(this.config.saveLocation)
  }

  /** A station's own save location if it overrides the app-wide one, else the
   *  same resolved path every other station uses. */
  getResolvedSaveLocationForStation(station: StationConfig): string {
    return station.saveLocationOverride
      ? resolveSaveLocation(station.saveLocationOverride)
      : this.getResolvedSaveLocation()
  }

  /** Raw (unresolved) default save location shipped in config.default.json -
   *  used by the Settings "Reset to default" action. */
  getDefaultSaveLocation(): string {
    return this.defaults.saveLocation
  }

  update(partial: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...partial }
    this.persist()
    this.emit('changed', this.config)
    logger.info('Configuration updated', { keys: Object.keys(partial) })
    return this.config
  }

  ensureDirectories(): void {
    fs.mkdirSync(this.getResolvedSaveLocation(), { recursive: true })
  }
}

// Fills in fields added after a config might have already been written to
// disk, so upgrading never silently hides or misconfigures an existing
// station (a missing `enabled` must default to true, not false).
function normalizeStation(station: Partial<StationConfig> & { id: string; name: string }): StationConfig {
  return {
    ...station,
    enabled: station.enabled ?? true,
    cameraName: station.cameraName ?? null,
    micName: station.micName ?? null,
    resolutionPreset: station.resolutionPreset ?? '1080p',
    fps: station.fps ?? 30,
    bitrateKbps: station.bitrateKbps ?? 8000,
    scannerDeviceId: station.scannerDeviceId ?? null,
    saveLocationOverride: station.saveLocationOverride ?? null
  }
}

export const configManager = new ConfigManager()
