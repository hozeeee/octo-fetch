import type { UtilityProcess } from 'electron'
import type { ProxyCredentials } from '../../shared/browser-options'
import type { CaptureConfig, CaptureDetail, CaptureGrant, CaptureLease, CapturePage, CaptureProcessRequest, CaptureReady, CaptureState } from '../../shared/capture'
import type { Site } from '../../shared/model'
import type { ProxyVault } from '../storage/proxy-vault'
import type { ConfigStore } from '../storage/store'
import { randomUUID, X509Certificate } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { captureGrantSchema, captureQuerySchema, captureSettingsFingerprint, captureSettingsSchema } from '../../shared/capture'
import { SerialQueue } from '../storage/store'
import { readCertificate, resetCertificate } from './certificates'

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Child = Pick<UtilityProcess, 'on' | 'postMessage' | 'kill' | 'pid'>
export type CaptureSpawn = (directory: string) => Promise<Child>
type Job = { child: Child; exited: boolean; expected: boolean; exit: Promise<void>; finish(): void }
type Pending = { job: Job; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
const replySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('count'), count: z.number().int().nonnegative() }),
  z.object({ type: z.literal('reply'), id: z.uuid(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(500).optional() })
])
async function spawnDefault(directory: string): Promise<Child> {
  const { utilityProcess } = await import('electron')
  return utilityProcess.fork(path.join(__dirname, 'capture-process.js'), [], {
    serviceName: 'Octo Fetch 抓包代理', stdio: 'ignore',
    env: { HOME: directory, PATH: '', OCTO_CAPTURE_HEARTBEAT: '1', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }
  })
}
async function wait(promise: Promise<void>, ms: number) {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(resolve, ms, false) })]) } finally { clearTimeout(timer) }
}

export class CaptureService {
  private queue = new SerialQueue()
  private job?: Job
  private ready?: CaptureReady
  private runtime?: CaptureConfig
  private generation?: string
  private phase: CaptureState['status'] = 'stopped'
  private error?: string
  private count = 0
  private fingerprint?: string
  private leases = new Map<string, { siteId: string; lease: CaptureLease }>()
  private pending = new Map<string, Pending>()
  private closing = false
  private draining = false
  private heartbeat?: NodeJS.Timeout
  readonly directory: string
  onUnavailable?: (siteIds: string[]) => void
  onStopped?: () => void
  constructor(private store: ConfigStore, private vault: ProxyVault, private changed: () => void, private spawn: CaptureSpawn = spawnDefault) {
    this.directory = path.join(store.directory, 'capture')
  }
  async initialize() {
    try { this.fingerprint = new X509Certificate(await readCertificate(this.directory)).fingerprint256 } catch { /* 首次启动前没有 CA。 */ }
    if (this.store.get().capture.settings.autoStart) await this.start().catch(() => undefined)
  }
  state(): CaptureState {
    const saved = this.store.get().capture, active = this.runtime
    const port = active?.settings.port ?? saved.settings.port
    const addresses = this.phase === 'running' ? [`127.0.0.1:${port}`] : []
    if (this.phase === 'running' && active?.settings.lan) {
      for (const list of Object.values(networkInterfaces())) {
        for (const address of list || []) {
          if (!address.internal && address.family === 'IPv4') addresses.push(`${address.address}:${port}`)
        }
      }
    }
    return { status: this.phase, port, pending: Boolean(active && captureSettingsFingerprint(active.settings, active.credentialId) !== captureSettingsFingerprint(saved.settings, saved.credentialId)), generation: this.generation, error: this.error, count: this.count, sites: [...new Set([...this.leases.values()].map((entry) => entry.siteId))], addresses, fingerprint: this.fingerprint }
  }
  // 管理鉴权只交给受信主进程中的原生视图，不进入 Snapshot 或脚本应答。
  management(): CaptureReady | undefined { return this.phase === 'running' && this.ready ? { ...this.ready } : undefined }
  isLeaseActive(lease: CaptureLease) { return this.phase === 'running' && lease.generation === this.generation && this.leases.has(lease.sourceId) }
  private assertOpen() { if (this.closing || this.draining) throw new Error('抓包服务正在停止，暂不能启动或修改') }
  private async collect() {
    const refs = [this.store.get().capture.credentialId, this.runtime?.credentialId].filter((id): id is string => Boolean(id))
    await this.vault.collect(new Set(refs)).catch(() => undefined)
  }
  save(raw: unknown, credentials?: ProxyCredentials | null) {
    return this.queue.run(async () => {
      this.assertOpen()
      const settings = captureSettingsSchema.parse(raw)
      if (settings.lan && !settings.allowedIps.length) throw new Error('开启局域网访问前请填写允许的客户端 IP')
      let credentialId = this.store.get().capture.credentialId
      if (!settings.upstream || credentials === null) credentialId = undefined
      if ((credentials || credentialId) && (!settings.upstream || new URL(settings.upstream.server).protocol === 'socks5:')) throw new Error('代理账号密码仅支持 HTTP/HTTPS 代理')
      const created = credentials ? await this.vault.create(credentials) : undefined
      if (created) credentialId = created
      try { await this.store.update((config) => { config.capture.settings = settings; config.capture.credentialId = credentialId }) } catch (error) { if (created) await this.vault.remove(created).catch(() => undefined); throw error }
      await this.collect(); this.changed()
    })
  }
  grant(scriptId: string, raw: CaptureGrant) {
    return this.queue.run(async () => {
      const id = z.uuid().parse(scriptId), grant = captureGrantSchema.parse(raw)
      await this.store.update((config) => { if (grant === 'none') delete config.capture.grants[id]; else config.capture.grants[id] = grant })
      this.changed()
    })
  }
  start(authorize?: () => void) { return this.queue.run(() => { authorize?.(); return this.startInternal() }) }
  private async startInternal() {
    this.assertOpen()
    if (this.phase === 'running') return
    if (this.leases.size) throw new Error('请先停止受影响的网站，再重新启动抓包代理')
    if (this.job) await this.terminate(this.job)
    this.phase = 'starting'; this.error = undefined; this.count = 0; this.changed()
    try {
      const runtime = this.store.get().capture
      const credentials = runtime.credentialId ? await this.vault.read(runtime.credentialId) : undefined
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700)
      const child = await this.spawn(this.directory)
      let finish!: () => void
      const job: Job = { child, exited: false, expected: false, exit: new Promise((resolve) => { finish = resolve }), finish: () => finish() }
      this.job = job; this.generation = randomUUID()
      child.on('message', (raw: unknown) => this.message(job, raw))
      child.on('exit', () => {
        job.exited = true; job.finish(); this.rejectPending(job, '抓包进程已退出')
        if (this.job !== job) return
        clearInterval(this.heartbeat); this.job = undefined; this.ready = undefined; this.onStopped?.()
        if (!job.expected) {
          this.phase = 'error'; this.error = '抓包进程意外退出；受影响网站不会自动直连，请停止并重启网站'
          this.onUnavailable?.(this.state().sites)
        }
        this.changed()
      })
      const ready = await this.rpc<CaptureReady>({ op: 'start', directory: this.directory, settings: runtime.settings, credentials, generation: this.generation }, 30000)
      if (job.exited) throw new Error('抓包进程在启动时退出')
      this.ready = ready; this.runtime = runtime; this.fingerprint = ready.fingerprint; this.phase = 'running'
      this.heartbeat = setInterval(() => { try { child.postMessage({ type: 'ping' }) } catch { /* exit 负责错误状态。 */ } }, 5000)
      this.changed()
    } catch (error) {
      if (this.job) await this.terminate(this.job)
      this.phase = 'error'; this.error = error instanceof Error ? error.message : '抓包启动失败'; this.changed()
      throw new Error(this.error)
    }
  }
  stop(authorize?: () => void) { return this.queue.run(() => { authorize?.(); return this.stopInternal() }) }
  restart() { return this.queue.run(async () => { this.assertOpen(); await this.stopInternal(); await this.startInternal() }) }
  // 不占用租约队列等待浏览器停止；释放租约仍可执行，新租约由 draining 拒绝。
  async stopWithSites(restart: boolean, stopSites: (ids: string[]) => Promise<void>) {
    const ids = await this.queue.run(async () => { this.assertOpen(); this.draining = true; return this.state().sites })
    try {
      await stopSites(ids)
      await this.queue.run(async () => { await this.stopInternal(); this.draining = false; if (restart) await this.startInternal() })
    } finally { this.draining = false }
  }
  private async stopInternal() {
    if (this.leases.size) throw new Error(`仍有 ${this.state().sites.length} 个关联网站，请先停止网站再停止抓包代理`)
    this.phase = 'stopping'; this.ready = undefined; this.onStopped?.(); this.changed()
    const job = this.job
    if (job) {
      job.expected = true
      this.rejectPending(job, '抓包服务正在停止')
      await this.rpc({ op: 'stop' }, 3000).catch(() => undefined)
      await this.terminate(job)
    }
    this.phase = 'stopped'; this.runtime = undefined; this.generation = undefined; this.error = undefined; this.count = 0
    await this.collect(); this.changed()
  }
  acquire(site: Site, generation: string, credentials?: ProxyCredentials): Promise<CaptureLease> {
    return this.queue.run(async () => {
      this.assertOpen()
      if (this.phase !== 'running') throw new Error('抓包代理未运行，请先在“抓包调试”中启动代理，再启动网站')
      const source = { id: randomUUID(), siteId: site.id, name: site.name, generation }
      let lease: CaptureLease
      try { lease = await this.rpc<CaptureLease>({ op: 'acquire', source, upstream: site.browserOptions.proxy, credentials }) } catch (error) {
        if (this.job) await this.terminate(this.job)
        this.phase = 'error'; this.error = '抓包入口分配失败，代理已停止，请检查原上游配置后重启'; this.onUnavailable?.(this.state().sites); this.changed()
        throw error
      }
      lease.generation = this.generation
      this.leases.set(lease.sourceId, { lease, siteId: site.id }); this.changed()
      return lease
    })
  }
  release(lease: CaptureLease) {
    return this.queue.run(async () => {
      if (!this.leases.has(lease.sourceId)) return
      if (this.phase === 'running' && lease.generation === this.generation) {
        try { await this.rpc({ op: 'release', sourceId: lease.sourceId }) } catch { if (this.job) await this.terminate(this.job); this.phase = 'error'; this.error = '抓包出口释放失败，代理已停止，请重启受影响网站'; this.onUnavailable?.(this.state().sites) }
      }
      this.leases.delete(lease.sourceId); this.changed()
    })
  }
  query(raw: unknown): Promise<CapturePage> { this.requireRunning(); return this.rpc({ op: 'query', query: captureQuerySchema.parse(raw) }) }
  detail(id: string, siteId?: string): Promise<CaptureDetail> { this.requireRunning(); return this.rpc({ op: 'get', recordId: z.string().min(1).max(200).parse(id), siteId: siteId ? z.uuid().parse(siteId) : undefined }) }
  certificate() { return this.queue.run(() => readCertificate(this.directory)) }
  resetCertificate() {
    return this.queue.run(async () => {
      if (this.job || this.leases.size || !['stopped', 'error'].includes(this.phase)) throw new Error('请先停止抓包代理和全部关联网站，再重置 CA')
      await resetCertificate(this.directory); this.fingerprint = undefined; this.changed()
    })
  }
  private requireRunning() { if (this.phase !== 'running') throw new Error('抓包代理未运行') }
  private message(job: Job, raw: unknown) {
    if (this.job !== job) return
    const parsed = replySchema.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    if (message.type === 'count') { this.count = message.count; this.changed(); return }
    const pending = this.pending.get(message.id)
    if (!pending || pending.job !== job) return
    clearTimeout(pending.timer); this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error || '抓包操作失败'))
  }
  private rpc<T>(command: WithoutId<CaptureProcessRequest>, timeout = 15000): Promise<T> {
    const job = this.job
    if (!job || job.exited) return Promise.reject(new Error('抓包进程不可用'))
    if (this.pending.size >= 128) return Promise.reject(new Error('抓包请求过多，请稍后重试'))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('抓包操作超时')) }, timeout)
      this.pending.set(id, { job, resolve: (value) => resolve(value as T), reject, timer })
      try { job.child.postMessage({ ...command, id }) } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('抓包进程通信失败')) }
    })
  }
  private rejectPending(job: Job, message: string) {
    for (const [id, pending] of this.pending) {
      if (pending.job === job) { clearTimeout(pending.timer); pending.reject(new Error(message)); this.pending.delete(id) }
    }
  }
  private async terminate(job: Job) {
    job.expected = true; clearInterval(this.heartbeat); this.rejectPending(job, '抓包服务已停止')
    if (!job.exited && !await wait(job.exit, 100)) {
      job.child.kill()
      if (!await wait(job.exit, 500) && job.child.pid !== undefined) {
        try { process.kill(job.child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      if (!await wait(job.exit, 2000)) throw new Error('无法确认抓包进程退出，请再次停止')
    }
    if (this.job === job) this.job = undefined
    this.ready = undefined; this.onStopped?.()
  }
  shutdown() { this.closing = true; return this.queue.run(() => this.stopInternal()) }
}
