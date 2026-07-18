import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { defaultPaths, resolveSaveLocation } from './PathService'
import { logger } from './Logger'
import { QUALITY_PRESETS, DEFAULT_QUALITY_PRESET_ID } from '@shared/types'
import type { AppConfig, StationConfig, QualityPresetId, WarehouseApiConfig } from '@shared/types'

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
    return {
      ...fallback,
      ...parsed,
      stations: stations.map(normalizeStation),
      warehouseApi: normalizeWarehouseApi(parsed.warehouseApi, fallback.warehouseApi)
    }
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

// Maps a config written before the Ultra HD (4K) / Full HD 60fps / Full HD /
// HD / Low Bandwidth preset system existed (which only stored a bare
// resolution string like "1080p" plus independently-editable fps/bitrate) to
// the closest new preset - "1080p" + fps 60 becomes the high-frame-rate
// preset specifically, since that combination has no other equivalent.
const LEGACY_RESOLUTION_TO_PRESET: Record<string, QualityPresetId> = {
  '4K': '4k30',
  '1440p': '1080p30',
  '1080p': '1080p30',
  '720p': '720p30'
}

function migrateQualityPreset(station: Partial<StationConfig> & { resolutionPreset?: string }): QualityPresetId {
  if (station.qualityPreset && station.qualityPreset in QUALITY_PRESETS) return station.qualityPreset
  const legacy = station.resolutionPreset
  if (legacy === '1080p' && station.fps === 60) return '1080p60'
  if (legacy && legacy in LEGACY_RESOLUTION_TO_PRESET) return LEGACY_RESOLUTION_TO_PRESET[legacy]
  return DEFAULT_QUALITY_PRESET_ID
}

// A config saved between v1.7.1 and v1.7.2 has warehouseApi.baseUrl instead
// of the current warehouseApi.url (the field was renamed once the
// integration settled on a single, exact endpoint rather than a prefix with
// paths appended). baseUrl was a PREFIX with `/scan` (or `/scan/confirm`)
// appended per request at send time (see ApiQueueService's pre-v1.7.3
// history) - `url` is the exact endpoint with nothing appended, so the
// rename that introduced `url` copied a legacy baseUrl straight across with
// no path appended. Worse, `load()` persists the merged config back to disk
// on every launch, so an affected install has by now had that
// under-specified value written into `url` itself, not just left sitting in
// the old `baseUrl` field - fixing only the `baseUrl` fallback wouldn't
// repair an install that's already been relaunched since. Confirmed against
// the real external API: the bare prefix (`.../warehouse/mobile`) 401s with
// "Full authentication is required"; the same prefix + `/scan` (the one
// path this app ever POSTs to now - see StationManager, the API is only
// called once, on stop) returns a real 200. Checking the *resulting*
// candidate URL rather than just the legacy field repairs both the
// never-migrated case and the already-migrated-wrong case the same way.
function normalizeWarehouseApi(
  raw: (Partial<WarehouseApiConfig> & { baseUrl?: string }) | undefined,
  fallback: WarehouseApiConfig
): WarehouseApiConfig {
  if (!raw) return fallback
  const candidate = (raw.url ?? raw.baseUrl ?? fallback.url).replace(/\/+$/, '')
  const url = candidate.endsWith('/warehouse/mobile') ? `${candidate}/scan` : candidate
  return {
    enabled: raw.enabled ?? fallback.enabled,
    url,
    apiKey: raw.apiKey ?? fallback.apiKey,
    scannerUser: raw.scannerUser ?? fallback.scannerUser,
    timeout: raw.timeout ?? fallback.timeout
  }
}

// Fills in fields added after a config might have already been written to
// disk, so upgrading never silently hides or misconfigures an existing
// station (a missing `enabled` must default to true, not false).
function normalizeStation(station: Partial<StationConfig> & { id: string; name: string }): StationConfig {
  const qualityPreset = migrateQualityPreset(station)
  const preset = QUALITY_PRESETS[qualityPreset]
  return {
    ...station,
    enabled: station.enabled ?? true,
    cameraId: station.cameraId ?? null,
    cameraName: station.cameraName ?? null,
    micName: station.micName ?? null,
    qualityPreset,
    // Always derived from the preset, never independently stored - see the
    // qualityPreset doc comment on StationConfig. This also repairs any
    // legacy config that had a hand-edited/inconsistent fps or bitrate.
    fps: preset.fps,
    bitrateKbps: preset.bitrateKbps,
    scannerDeviceId: station.scannerDeviceId ?? null,
    saveLocationOverride: station.saveLocationOverride ?? null
  }
}

export const configManager = new ConfigManager()
