import { EventEmitter } from 'node:events'
import { database, type ApiQueueItem } from './Database'
import { configManager } from './ConfigManager'
import { logger } from './Logger'
import type { ApiQueueStatus, WarehouseApiConfig, WarehouseApiTestResult } from '@shared/types'

const RETRY_INTERVAL_MS = 30000
const BATCH_SIZE = 20

/** Reports every barcode scan to an external warehouse API as a durable,
 *  retrying outbox - see Database's api_queue table. Recording itself never
 *  depends on this succeeding (this app works fully offline; the API sync is
 *  a best-effort extra), so a scan is enqueued and persisted immediately,
 *  then this service drains it in the background on its own schedule,
 *  independent of the recording/barcode workflow. Runs entirely in the main
 *  process - the renderer never sees the API key or makes this request
 *  itself (see registerIpcHandlers' config sanitization). */
class ApiQueueService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private processing = false

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.processQueue().catch((err) => logger.error('API queue processing failed', { error: (err as Error).message }))
    }, RETRY_INTERVAL_MS)
    // Drain anything left over from a previous session immediately, instead
    // of waiting for the first interval tick.
    this.processQueue().catch((err) => logger.error('Initial API queue processing failed', { error: (err as Error).message }))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** No-op when the integration isn't enabled in Settings, so every call
   *  site (StationManager) can call this unconditionally on every scan
   *  without checking config itself. */
  enqueue(kind: 'scan' | 'confirm', orderNumber: string, scannerDevice: string, station: string): void {
    const config = configManager.get().warehouseApi
    if (!config.enabled) return

    database.enqueueApiScan({ kind, orderNumber, scannerDevice, scannerUser: config.scannerUser })
    logger.info('Warehouse API: scan queued', { kind, orderNumber, scannerDevice, station })
    this.emit('queueChanged')
    this.processQueue().catch((err) => logger.error('API queue processing failed', { error: (err as Error).message }))
  }

  getStatus(): ApiQueueStatus {
    return database.getApiQueueStatus()
  }

  /** One-off, unqueued diagnostic POST for the Settings page's "Test
   *  Connection" button - a fixed TEST123456 payload, never touches the
   *  database or the real scan queue, and returns the raw HTTP result
   *  (status/body) directly to the caller instead of just success/failure,
   *  so the operator can see exactly what the server said. `config` is
   *  taken as a parameter (the renderer's current draft, not necessarily
   *  saved yet) rather than read from disk, so testing works before hitting
   *  Save - see registerIpcHandlers for how a not-yet-changed apiKey
   *  placeholder gets resolved back to the real stored key first. */
  async testConnection(config: WarehouseApiConfig): Promise<WarehouseApiTestResult> {
    const requestStartedAt = Date.now()
    if (!config.url) {
      return { success: false, statusCode: null, responseBody: null, error: 'ยังไม่ได้กำหนด API URL', durationMs: 0 }
    }
    if (!config.url.toLowerCase().startsWith('https://')) {
      return { success: false, statusCode: null, responseBody: null, error: 'API URL ต้องใช้ HTTPS', durationMs: 0 }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeout || 10000)
    logger.info('Warehouse API: test connection requested', { url: config.url })

    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: 'TEST123456',
          scannerDevice: 'TEST_SCANNER',
          scannerUser: config.scannerUser
        }),
        signal: controller.signal
      })
      const durationMs = Date.now() - requestStartedAt
      const responseBody = await response.text().catch(() => '')

      logger.info('Warehouse API: test connection result', {
        url: config.url,
        responseCode: response.status,
        durationMs,
        outcome: response.ok ? 'success' : 'failure'
      })

      return {
        success: response.ok,
        statusCode: response.status,
        responseBody: responseBody || null,
        error: response.ok ? null : responseBody || `HTTP ${response.status}`,
        durationMs
      }
    } catch (err) {
      const durationMs = Date.now() - requestStartedAt
      const message = (err as Error).message
      logger.warn('Warehouse API: test connection failed', { url: config.url, durationMs, error: message })
      return { success: false, statusCode: null, responseBody: null, error: message, durationMs }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    const config = configManager.get().warehouseApi
    if (!config.enabled || !config.apiKey || !config.url) return

    this.processing = true
    try {
      const pending = database.getPendingApiScans(BATCH_SIZE)
      for (const item of pending) {
        const outcome = await this.sendOne(config.url, config.apiKey, config.timeout, item)
        // A network-level failure (server unreachable, DNS down, timeout)
        // means every other queued item would fail the same way right now -
        // stop this pass instead of burning through the whole batch one
        // timeout at a time. A server-returned error (bad request, auth
        // rejected) only concerns that one item, so keep going.
        if (outcome === 'network-error') break
      }
    } finally {
      this.processing = false
    }
  }

  private async sendOne(
    url: string,
    apiKey: string,
    timeoutMs: number,
    item: ApiQueueItem
  ): Promise<'sent' | 'rejected' | 'network-error'> {
    if (!url.toLowerCase().startsWith('https://')) {
      logger.error('Warehouse API: refusing to call a non-HTTPS URL', { url })
      database.markApiScanFailed(item.id, 'API URL must use HTTPS')
      this.emit('queueChanged')
      return 'rejected'
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const requestStartedAt = Date.now()

    // Every request is logged - time, barcode, station is carried in the
    // caller's enqueue() log line since it's not part of the wire payload,
    // scanner, URL, response code, response time, success/failure. The key
    // itself is never included in any log line.
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: item.orderNumber,
          scannerDevice: item.scannerDevice,
          scannerUser: item.scannerUser
        }),
        signal: controller.signal
      })
      const responseTimeMs = Date.now() - requestStartedAt

      if (response.ok) {
        database.markApiScanSent(item.id)
        database.noteApiScanSuccess()
        logger.info('Warehouse API: request succeeded', {
          orderNumber: item.orderNumber,
          scannerDevice: item.scannerDevice,
          url,
          responseCode: response.status,
          responseTimeMs,
          outcome: 'success'
        })
        this.emit('queueChanged')
        return 'sent'
      }

      const body = await response.text().catch(() => '')
      database.markApiScanFailed(item.id, `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
      logger.warn('Warehouse API: request rejected by server', {
        orderNumber: item.orderNumber,
        scannerDevice: item.scannerDevice,
        url,
        responseCode: response.status,
        responseTimeMs,
        outcome: 'failure'
      })
      this.emit('queueChanged')
      return 'rejected'
    } catch (err) {
      const responseTimeMs = Date.now() - requestStartedAt
      const message = (err as Error).message
      database.markApiScanFailed(item.id, message)
      logger.warn('Warehouse API: request failed (network error)', {
        orderNumber: item.orderNumber,
        scannerDevice: item.scannerDevice,
        url,
        responseCode: null,
        responseTimeMs,
        outcome: 'failure',
        error: message
      })
      this.emit('queueChanged')
      return 'network-error'
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const apiQueueService = new ApiQueueService()
