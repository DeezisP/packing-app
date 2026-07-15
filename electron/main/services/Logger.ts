import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { defaultPaths } from './PathService'
import type { LogEntry } from '@shared/types'

const MAX_LOG_BYTES = 5 * 1024 * 1024 // rotate a file once it crosses 5MB
const MAX_ROTATED_FILES = 5

class LoggerService extends EventEmitter {
  private appLogPath: string
  private errorLogPath: string
  private ready = false

  constructor() {
    super()
    this.appLogPath = path.join(defaultPaths.logsDir, 'app.log')
    this.errorLogPath = path.join(defaultPaths.logsDir, 'error.log')
  }

  init(): void {
    fs.mkdirSync(defaultPaths.logsDir, { recursive: true })
    this.ready = true
    this.info('Logger initialized', { logsDir: defaultPaths.logsDir })
  }

  private rotateIfNeeded(filePath: string): void {
    try {
      const stat = fs.statSync(filePath)
      if (stat.size < MAX_LOG_BYTES) return
    } catch {
      return // file does not exist yet
    }

    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`
      const dest = `${filePath}.${i + 1}`
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest)
      }
    }
    fs.renameSync(filePath, `${filePath}.1`)
  }

  private write(entry: LogEntry): void {
    if (!this.ready) return
    const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}\n`

    this.rotateIfNeeded(this.appLogPath)
    fs.appendFileSync(this.appLogPath, line)

    if (entry.level === 'error') {
      this.rotateIfNeeded(this.errorLogPath)
      fs.appendFileSync(this.errorLogPath, line)
    }

    this.emit('entry', entry)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write({ timestamp: new Date().toISOString(), level: 'info', message: withMeta(message, meta) })
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write({ timestamp: new Date().toISOString(), level: 'warn', message: withMeta(message, meta) })
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write({ timestamp: new Date().toISOString(), level: 'error', message: withMeta(message, meta) })
  }

  getRecentEntries(limit = 200): LogEntry[] {
    if (!fs.existsSync(this.appLogPath)) return []
    const raw = fs.readFileSync(this.appLogPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-limit)
    return lines.map(parseLine).filter((e): e is LogEntry => e !== null)
  }
}

function withMeta(message: string, meta?: Record<string, unknown>): string {
  if (!meta) return message
  try {
    return `${message} ${JSON.stringify(meta)}`
  } catch {
    return message
  }
}

function parseLine(line: string): LogEntry | null {
  const match = line.match(/^\[(.+?)\] \[(INFO|WARN|ERROR)\] (.*)$/)
  if (!match) return null
  return {
    timestamp: match[1],
    level: match[2].toLowerCase() as LogEntry['level'],
    message: match[3]
  }
}

export const logger = new LoggerService()
