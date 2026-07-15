import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { defaultPaths, resolveSaveLocation } from './PathService'
import { logger } from './Logger'
import type { AppConfig } from '@shared/types'

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
    if (!fs.existsSync(defaultPaths.configFile)) {
      fs.writeFileSync(defaultPaths.configFile, JSON.stringify(fallback, null, 2))
      return fallback
    }
    try {
      const raw = fs.readFileSync(defaultPaths.configFile, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      // Shallow-merge so new fields introduced by app updates get sane defaults.
      return { ...fallback, ...parsed, stations: parsed.stations?.length ? parsed.stations : fallback.stations }
    } catch (err) {
      logger.error('Failed to parse config.json, falling back to defaults', {
        error: (err as Error).message
      })
      return fallback
    }
  }

  private persist(): void {
    fs.writeFileSync(defaultPaths.configFile, JSON.stringify(this.config, null, 2))
  }

  get(): AppConfig {
    return this.config
  }

  getResolvedSaveLocation(): string {
    return resolveSaveLocation(this.config.saveLocation)
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

export const configManager = new ConfigManager()
