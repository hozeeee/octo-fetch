import type { NotificationConfig, NotificationLog, NotificationPage, NotificationQuery } from '../../shared/notifications'
import type { ConfigStore, Encryptor } from '../storage/store'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { configSchema } from '../../shared/model'
import { MAX_NOTIFICATION_LOGS, notificationConfigSchema, notificationLogSchema, notificationQuerySchema, notificationTerminal } from '../../shared/notifications'
import { atomicWrite, SerialQueue } from '../storage/store'

export class NotificationVault {
  constructor(private directory: string, private encryptor: Encryptor) {}
  private file(id: string) { return path.join(this.directory, 'notification-credentials', `${z.uuid().parse(id)}.enc`) }
  async create(config: NotificationConfig): Promise<string> {
    const id = randomUUID()
    try { await atomicWrite(this.file(id), await this.encryptor.encrypt(JSON.stringify(notificationConfigSchema.parse(config)))) } catch { throw new Error('通知配置加密保存失败，请检查钥匙串授权及磁盘空间') }
    return id
  }
  async read(id: string): Promise<NotificationConfig> {
    try { return notificationConfigSchema.parse(JSON.parse(await this.encryptor.decrypt(await readFile(this.file(id))))) } catch { throw new Error('通知配置读取或解密失败，请检查钥匙串授权或重新填写完整配置') }
  }
  async collect(config: ConfigStore, inFlight: Set<string>): Promise<void> {
    const refs = new Set([...inFlight, ...config.get().notifications.map((item) => item.credentialId)])
    try {
      const backup = configSchema.parse(JSON.parse(await readFile(`${config.file}.bak`, 'utf8')))
      backup.notifications.forEach((item) => refs.add(item.credentialId))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return }
    let files: string[]
    try { files = await readdir(path.join(this.directory, 'notification-credentials')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const file of files) {
      const id = file.replace(/\.enc$/, '')
      if (file.endsWith('.enc') && z.uuid().safeParse(id).success && !refs.has(id)) await rm(this.file(id), { force: true })
    }
  }
}

// 记录先进入有界内存，异步批量落盘；磁盘故障不会阻塞发送及脚本。
export class NotificationLogStore {
  private records = new Map<string, NotificationLog>()
  private queue = new SerialQueue()
  private timer?: NodeJS.Timeout
  private blocked = false
  private dirty = false
  warning?: string
  readonly file: string
  constructor(directory: string, private changed: () => void = () => undefined) { this.file = path.join(directory, 'notification-logs.json') }
  async initialize() {
    try {
      const records = z.array(notificationLogSchema).max(MAX_NOTIFICATION_LOGS + 100).parse(JSON.parse(await readFile(this.file, 'utf8')))
      for (const record of records) {
        if (!notificationTerminal(record.status)) {
          record.status = record.status === 'sending' ? 'unknown' : 'interrupted'
          record.error = '上次应用退出时未完成，不会自动重发'
          record.endedAt = new Date().toISOString()
        }
        this.records.set(record.id, record)
      }
      this.trim(); this.schedule()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.blocked = true
        this.warning = '通知日志无法读取，原文件已保留；新记录暂存于内存，请检查数据目录。'
        this.changed()
      }
    }
  }
  private trim() {
    const terminal = [...this.records.values()].filter((item) => notificationTerminal(item.status))
    for (const item of terminal.slice(0, Math.max(0, terminal.length - MAX_NOTIFICATION_LOGS))) this.records.delete(item.id)
  }
  put(record: NotificationLog) {
    this.records.set(record.id, structuredClone(record)); this.trim(); this.schedule(); this.changed()
  }
  get(id: string) { const item = this.records.get(id); return item && structuredClone(item) }
  list(raw: NotificationQuery = {}): NotificationPage {
    const query = notificationQuerySchema.parse(raw)
    const items = [...this.records.values()].reverse().filter((item) => (!query.key || item.key === query.key) && (!query.status || item.status === query.status) && (!query.kind || item.source.kind === query.kind) && (!query.runId || item.source.runId === query.runId))
    return { total: items.length, items: structuredClone(items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)) }
  }
  latest(channelId: string) { return [...this.records.values()].reverse().find((item) => item.channelId === channelId) }
  clear() {
    for (const item of this.records.values()) {
      if (notificationTerminal(item.status)) this.records.delete(item.id)
    }
    this.schedule(); this.changed()
  }
  private schedule() {
    this.dirty = true
    if (!this.timer && !this.blocked) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 100)
  }
  async flush() {
    clearTimeout(this.timer); this.timer = undefined
    await this.queue.run(async () => {
      if (!this.dirty || this.blocked) return
      this.dirty = false
      const snapshot = JSON.stringify([...this.records.values()])
      try { await atomicWrite(this.file, snapshot); this.warning = undefined } catch { this.dirty = true; this.warning = '通知日志写入失败，最近记录暂存内存，请检查磁盘空间或权限。' }
      this.changed()
    })
  }
}
