import type { ChannelDraft, ChannelSummary, NotificationChannel, NotificationDetail, NotificationLog, NotificationPatch, NotificationRequest, NotificationSource, NotificationStatus } from '../../shared/notifications'
import type { ConfigStore } from '../storage/store'
import type { NotificationLogStore, NotificationVault } from './store'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { channelDraftSchema, MAX_CHANNELS, notificationConfigSchema, notificationPatchSchema, notificationRequestSchema, notificationSourceSchema, notificationTerminal } from '../../shared/notifications'
import { SerialQueue } from '../storage/store'
import { NotificationError, sendNotification } from './adapters'

type Job = { channel: NotificationChannel; request: NotificationRequest; log: NotificationLog; controller: AbortController; dispatched: boolean; promise?: Promise<void> }
export class NotificationService {
  private mutations = new SerialQueue()
  private jobs: Job[] = []
  private active = new Set<string>()
  private rates = new Map<string, number[]>()
  private aggregates = new Map<string, { id: string; at: number }>()
  private timer?: NodeJS.Timeout
  private closing = false
  private drainScheduled = false
  warning?: string
  constructor(private config: ConfigStore, readonly vault: NotificationVault, readonly logs: NotificationLogStore, private changed: () => void, private deliver = sendNotification) {}
  list(): ChannelSummary[] {
    return this.config.get().notifications.map(({ credentialId: _credentialId, prefix: _prefix, ...channel }) => {
      const last = this.logs.latest(channel.id)
      return { ...channel, ...(last ? { last: { createdAt: last.createdAt, status: last.status } } : {}) }
    })
  }
  private channel(id: string) {
    const channel = this.config.get().notifications.find((item) => item.id === z.uuid().parse(id))
    if (!channel) throw new Error('通知通道不存在')
    return channel
  }
  async detail(id: string): Promise<NotificationDetail> {
    const channel = this.channel(id)
    const config = await this.vault.read(channel.credentialId)
    const settings: NotificationPatch = config.kind === 'smtp' ? { host: config.host, port: config.port, security: config.security, username: config.username, from: config.from, to: config.to, cc: config.cc } : config.kind === 'webhook' ? { allowHttp: config.allowHttp } : {}
    return { channel, settings, configured: { url: 'url' in config, secret: 'secret' in config && Boolean(config.secret), password: 'password' in config, headers: 'headers' in config && config.headers.length > 0 } }
  }
  save(id: string | undefined, raw: ChannelDraft, patch: NotificationPatch): Promise<void> {
    const draft = channelDraftSchema.parse(raw), settings = notificationPatchSchema.parse(patch)
    return this.mutations.run(async () => {
      if (this.closing) throw new Error('应用正在退出')
      const previous = id ? this.channel(id) : undefined
      if (previous && (previous.key !== draft.key || previous.kind !== draft.kind)) throw new Error('调用标识和渠道类型创建后不可修改')
      const channels = this.config.get().notifications
      if (channels.some((item) => item.key === draft.key && item.id !== id)) throw new Error('调用标识已被使用')
      if (!previous && channels.length >= MAX_CHANNELS) throw new Error('最多保存 100 个通知通道')
      // 完整替换允许修复损坏密文；仅部分编辑时必须能够读取原配置。
      let merged: Record<string, unknown> = { kind: draft.kind, ...settings }
      if (previous) {
        try { merged = { ...await this.vault.read(previous.credentialId), ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) } } catch { if (!notificationConfigSchema.safeParse(merged).success) throw new Error('旧通知配置无法解密，请重新填写完整配置') }
      }
      if (merged.secret === null) delete merged.secret
      if (merged.headers === null) merged.headers = []
      const parsed = notificationConfigSchema.safeParse(merged)
      if (!parsed.success) throw new Error(`通知配置无效：${parsed.error.issues.map((issue) => issue.path.join('.') || '配置').join('、')}，请检查必填项、官方地址和安全设置`)
      const credentialId = await this.vault.create(parsed.data)
      const now = new Date().toISOString()
      await this.config.update((config) => {
        const next = { ...draft, id: previous?.id || randomUUID(), credentialId, createdAt: previous?.createdAt || now, updatedAt: now }
        const index = config.notifications.findIndex((item) => item.id === id)
        if (index >= 0) config.notifications[index] = next; else config.notifications.push(next)
      })
      if (previous && !draft.enabled) this.skipPending(previous.id)
      this.changed(); await this.collect()
    })
  }
  enable(id: string, enabled: boolean) {
    return this.mutations.run(async () => {
      this.channel(id)
      await this.config.update((config) => { const channel = config.notifications.find((item) => item.id === id)!; channel.enabled = enabled; channel.updatedAt = new Date().toISOString() })
      if (!enabled) this.skipPending(id)
      this.changed()
    })
  }
  remove(id: string) {
    return this.mutations.run(async () => {
      this.channel(id)
      await this.config.update((config) => { config.notifications = config.notifications.filter((item) => item.id !== id) })
      this.skipPending(id); this.rates.delete(id); this.changed(); await this.collect()
    })
  }
  private async collect() {
    try { await this.vault.collect(this.config, new Set(this.jobs.map((job) => job.channel.credentialId))) } catch { this.warning = '通知旧凭据清理失败，现有配置和发送不受影响。'; this.changed() }
  }
  test(id: string) {
    const channel = this.channel(id)
    if (!channel.enabled) throw new Error('请先启用通道再测试')
    this.submit({ id: randomUUID(), targets: [channel.key], message: { title: 'Octo Fetch 测试通知', content: '这是一条通知管理测试消息。' } }, { kind: 'test' })
  }
  // 此入口不等待磁盘/网络；异常不得传播到脚本消息处理器。
  submit(raw: NotificationRequest, origin: NotificationSource): void {
    try {
      const request = notificationRequestSchema.parse(raw), source = notificationSourceSchema.parse(origin)
      const channels = this.config.get().notifications
      for (const key of new Set(request.targets)) {
        const channel = channels.find((item) => item.key === key)
        const log: NotificationLog = { id: randomUUID(), submissionId: request.id, channelId: channel?.id, key, name: channel?.name || key, title: request.message.title, source, createdAt: new Date().toISOString(), status: 'queued', count: 1 }
        if (this.closing) { this.reject(log, 'interrupted', 'CLOSING', '应用正在退出'); continue }
        if (!channel) { this.reject(log, 'failed', 'NOT_FOUND', '通知通道不存在'); continue }
        if (!channel.enabled) { this.reject(log, 'skipped', 'DISABLED', '通知通道已停用'); continue }
        const now = Date.now(), rate = (this.rates.get(channel.id) || []).filter((time) => now - time < 60000)
        this.rates.set(channel.id, rate)
        if (rate.length >= 20) { this.reject(log, 'skipped', 'RATE_LIMIT', '通道每分钟最多 20 次投递，连续超额已合并'); continue }
        if (this.jobs.length >= 100) { this.reject(log, 'skipped', 'QUEUE_FULL', '通知队列已满，连续超额已合并'); continue }
        rate.push(now)
        this.jobs.push({ channel, request, log, controller: new AbortController(), dispatched: false })
        this.logs.put(log)
      }
      this.schedule()
    } catch { this.warning = '通知提交无效，已隔离处理，不影响脚本运行。'; this.changed() }
  }
  private reject(log: NotificationLog, status: NotificationStatus, code: string, error: string) {
    if (code !== 'RATE_LIMIT' && code !== 'QUEUE_FULL') { this.finishLog(log, status, code, error); return }
    const key = `${log.source.runId || 'test'}:${log.key}:${code}`, now = Date.now()
    for (const [id, value] of this.aggregates) {
      if (now - value.at >= 60000) this.aggregates.delete(id)
    }
    const previous = this.aggregates.get(key), record = previous && this.logs.get(previous.id)
    if (record) { record.count++; this.logs.put(record); return }
    if (this.aggregates.size >= 1000) this.aggregates.delete(this.aggregates.keys().next().value!)
    this.aggregates.set(key, { id: log.id, at: now })
    this.finishLog(log, status, code, error)
  }
  private finishLog(log: NotificationLog, status: NotificationStatus, code?: string, error?: string) {
    log.status = status; log.code = code; log.error = error; log.endedAt = new Date().toISOString()
    log.duration = Math.max(0, Date.now() - Date.parse(log.startedAt || log.createdAt))
    this.logs.put(log)
  }
  private skipPending(id: string) {
    for (const job of [...this.jobs]) {
      if (job.channel.id === id && !job.dispatched) {
        this.finishLog(job.log, 'skipped', 'DISABLED', '通道已停用或删除，未开始的投递已跳过')
        job.controller.abort()
        if (!job.promise) this.jobs.splice(this.jobs.indexOf(job), 1)
      }
    }
  }
  private schedule() {
    if (this.closing || this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => { this.drainScheduled = false; this.drain() })
  }
  private drain() {
    clearTimeout(this.timer); this.timer = undefined
    if (this.closing) return
    for (const job of [...this.jobs]) {
      if (job.promise) continue
      if (Date.now() - Date.parse(job.log.createdAt) >= 60000) {
        this.finishLog(job.log, 'failed', 'QUEUE_TIMEOUT', '排队超过 60 秒，未发送'); this.jobs.splice(this.jobs.indexOf(job), 1); continue
      }
      if (this.active.size >= 4 || this.active.has(job.channel.id)) continue
      this.active.add(job.channel.id)
      job.promise = this.send(job).finally(() => {
        this.active.delete(job.channel.id)
        const index = this.jobs.indexOf(job); if (index >= 0) this.jobs.splice(index, 1)
        this.schedule()
      })
    }
    if (this.jobs.some((job) => !job.promise)) this.timer = setTimeout(() => this.drain(), 1000)
  }
  private async send(job: Job) {
    const { log, controller } = job
    let onAbort: () => void = () => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new NotificationError('ABORTED', '发送超时或应用退出，无法确认结果', job.dispatched))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      await Promise.race([aborted, (async () => {
        let config
        try { config = await this.vault.read(job.channel.credentialId) } catch { throw new NotificationError('CREDENTIALS', '通知配置读取或解密失败，请检查钥匙串授权') }
        controller.signal.throwIfAborted()
        const current = this.config.get().notifications.find((item) => item.id === job.channel.id)
        if (!current?.enabled) throw new NotificationError('DISABLED', '通知通道已停用或删除')
        job.dispatched = true; log.status = 'sending'; log.startedAt = new Date().toISOString(); this.logs.put(log)
        await this.deliver(config, { id: log.id, createdAt: log.createdAt, source: log.source, message: job.request.message, prefix: job.channel.prefix }, controller.signal)
      })()])
      if (!notificationTerminal(log.status)) this.finishLog(log, 'accepted')
    } catch (error) {
      if (!notificationTerminal(log.status)) {
        const safe = error instanceof NotificationError ? error : new NotificationError('SEND_ERROR', '通知发送异常，未能确认结果', job.dispatched)
        this.finishLog(log, safe.unknown ? 'unknown' : 'failed', safe.code, safe.message)
      }
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort) }
  }
  async shutdown() {
    this.closing = true; clearTimeout(this.timer)
    for (const job of [...this.jobs]) {
      if (!job.promise) {
        this.finishLog(job.log, 'interrupted', 'CLOSING', '应用退出，未发送'); this.jobs.splice(this.jobs.indexOf(job), 1)
      }
    }
    const pending = Promise.all(this.jobs.map((job) => job.promise))
    let timer: NodeJS.Timeout | undefined
    await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000) })]); clearTimeout(timer)
    for (const job of this.jobs) {
      if (!notificationTerminal(job.log.status)) this.finishLog(job.log, job.dispatched ? 'unknown' : 'interrupted', 'CLOSING', '应用退出，未确认结果，不会自动重发')
      job.controller.abort()
    }
    await pending
    await this.logs.flush()
  }
}
