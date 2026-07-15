import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { defaultPaths } from './PathService'
import { logger } from './Logger'
import { toMediaUrl } from './MediaProtocol'
import type { RecordingRecord, RecordingStatus, SearchFilters } from '@shared/types'

// sql.js is a pure WebAssembly build of SQLite - it needs zero native
// compilation (no node-gyp/Visual Studio/Python required at npm install
// time), which is what makes "copy the folder to another PC, npm install,
// npm run build" reliably work. The whole database lives in memory and is
// flushed to disk on a short interval and after every write-heavy action.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS recordings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode         TEXT NOT NULL,
  station         TEXT NOT NULL,
  camera          TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT,
  duration_seconds INTEGER,
  video_path      TEXT NOT NULL,
  thumbnail_path  TEXT,
  resolution      TEXT NOT NULL,
  fps             INTEGER NOT NULL,
  bitrate_kbps    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('recording', 'completed', 'interrupted', 'error')),
  created_date    TEXT NOT NULL,
  last_viewed     TEXT
);
CREATE INDEX IF NOT EXISTS idx_recordings_barcode ON recordings (barcode);
CREATE INDEX IF NOT EXISTS idx_recordings_station ON recordings (station);
CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings (camera);
CREATE INDEX IF NOT EXISTS idx_recordings_created_date ON recordings (created_date);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status);
`

const FLUSH_INTERVAL_MS = 3000

interface RecordingRow {
  id: number
  barcode: string
  station: string
  camera: string
  start_time: string
  end_time: string | null
  duration_seconds: number | null
  video_path: string
  thumbnail_path: string | null
  resolution: string
  fps: number
  bitrate_kbps: number
  status: RecordingStatus
  created_date: string
  last_viewed: string | null
}

function rowToRecord(row: RecordingRow): RecordingRecord {
  return {
    id: row.id,
    barcode: row.barcode,
    station: row.station,
    camera: row.camera,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    videoPath: row.video_path,
    thumbnailPath: row.thumbnail_path,
    videoUrl: toMediaUrl(row.video_path),
    thumbnailUrl: row.thumbnail_path ? toMediaUrl(row.thumbnail_path) : null,
    resolution: row.resolution,
    fps: row.fps,
    bitrateKbps: row.bitrate_kbps,
    status: row.status,
    createdDate: row.created_date,
    lastViewed: row.last_viewed
  }
}

class DatabaseService {
  private db!: SqlJsDatabase
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  async init(): Promise<void> {
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'))
    const SQL = await initSqlJs({ locateFile: (file: string) => path.join(wasmDir, file) })

    fs.mkdirSync(path.dirname(defaultPaths.databaseFile), { recursive: true })
    if (fs.existsSync(defaultPaths.databaseFile)) {
      this.db = new SQL.Database(fs.readFileSync(defaultPaths.databaseFile))
    } else {
      this.db = new SQL.Database()
    }
    this.db.run(SCHEMA)
    this.flush()

    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush()
    }, FLUSH_INTERVAL_MS)

    logger.info('Database initialized', { path: defaultPaths.databaseFile })
  }

  private flush(): void {
    const data = this.db.export()
    const tmpPath = `${defaultPaths.databaseFile}.tmp`
    fs.writeFileSync(tmpPath, Buffer.from(data))
    fs.renameSync(tmpPath, defaultPaths.databaseFile)
    this.dirty = false
  }

  private run(sql: string, params: (string | number | null)[] = []): void {
    this.db.run(sql, params)
    this.dirty = true
  }

  private queryOne<T>(sql: string, params: (string | number | null)[] = []): T | null {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const row = stmt.step() ? (stmt.getAsObject() as T) : null
    stmt.free()
    return row
  }

  private queryAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T)
    }
    stmt.free()
    return rows
  }

  /** Recovers from a crash: any row still marked 'recording' at startup means
   *  the previous process died mid-capture. Mark it interrupted instead of
   *  silently pretending it succeeded. */
  recoverOrphanedRecordings(): number {
    this.run(`UPDATE recordings SET status = 'interrupted', end_time = COALESCE(end_time, ?) WHERE status = 'recording'`, [
      new Date().toISOString()
    ])
    const changed = this.db.getRowsModified()
    if (changed > 0) {
      logger.warn('Recovered orphaned recordings from previous session', { count: changed })
      this.flush()
    }
    return changed
  }

  insertRecordingStart(input: {
    barcode: string
    station: string
    camera: string
    videoPath: string
    resolution: string
    fps: number
    bitrateKbps: number
  }): number {
    const now = new Date().toISOString()
    this.run(
      `INSERT INTO recordings
        (barcode, station, camera, start_time, video_path, resolution, fps, bitrate_kbps, status, created_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?)`,
      [input.barcode, input.station, input.camera, now, input.videoPath, input.resolution, input.fps, input.bitrateKbps, now]
    )
    const row = this.queryOne<{ id: number }>('SELECT last_insert_rowid() as id')
    this.flush()
    return row?.id ?? -1
  }

  completeRecording(id: number, thumbnailPath: string | null): void {
    const row = this.queryOne<{ start_time: string }>('SELECT start_time FROM recordings WHERE id = ?', [id])
    const endTime = new Date().toISOString()
    const durationSeconds = row ? Math.round((Date.parse(endTime) - Date.parse(row.start_time)) / 1000) : null
    this.run(`UPDATE recordings SET status = 'completed', end_time = ?, duration_seconds = ?, thumbnail_path = ? WHERE id = ?`, [
      endTime,
      durationSeconds,
      thumbnailPath,
      id
    ])
    this.flush()
  }

  markError(id: number, message: string): void {
    this.run(`UPDATE recordings SET status = 'error', end_time = ? WHERE id = ?`, [new Date().toISOString(), id])
    this.flush()
    logger.error('Recording marked as error', { id, message })
  }

  findExistingByBarcode(barcode: string): RecordingRecord | null {
    const row = this.queryOne<RecordingRow>(`SELECT * FROM recordings WHERE barcode = ? ORDER BY id DESC LIMIT 1`, [
      barcode
    ])
    return row ? rowToRecord(row) : null
  }

  search(filters: SearchFilters): RecordingRecord[] {
    const clauses: string[] = []
    const params: (string | number)[] = []

    if (filters.barcode) {
      clauses.push('barcode LIKE ?')
      params.push(`%${filters.barcode}%`)
    }
    if (filters.station) {
      clauses.push('station = ?')
      params.push(filters.station)
    }
    if (filters.camera) {
      clauses.push('camera = ?')
      params.push(filters.camera)
    }
    if (filters.dateFrom) {
      clauses.push('created_date >= ?')
      params.push(filters.dateFrom)
    }
    if (filters.dateTo) {
      clauses.push('created_date <= ?')
      params.push(filters.dateTo)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.queryAll<RecordingRow>(`SELECT * FROM recordings ${where} ORDER BY id DESC LIMIT 500`, params)
    return rows.map(rowToRecord)
  }

  getRecent(limit: number): RecordingRecord[] {
    const rows = this.queryAll<RecordingRow>(`SELECT * FROM recordings ORDER BY id DESC LIMIT ?`, [limit])
    return rows.map(rowToRecord)
  }

  countAll(): number {
    const row = this.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM recordings`)
    return row?.c ?? 0
  }

  countActive(): number {
    const row = this.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM recordings WHERE status = 'recording'`)
    return row?.c ?? 0
  }

  markViewed(id: number): void {
    this.run(`UPDATE recordings SET last_viewed = ? WHERE id = ?`, [new Date().toISOString(), id])
    this.flush()
  }

  backup(destinationPath: string): void {
    try {
      this.flush()
      fs.copyFileSync(defaultPaths.databaseFile, destinationPath)
    } catch (err) {
      logger.error('Database backup failed', { error: (err as Error).message })
    }
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.dirty) this.flush()
    this.db?.close()
  }
}

export const database = new DatabaseService()
