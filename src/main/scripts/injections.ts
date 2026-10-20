import type { BrowserConnectionOptions } from '../../shared/browser-options'
import type { Hook, InjectionBinding, InjectionMessage, InjectionScript, InjectionState, InjectionWorkerInput, WorkerOperation } from '../../shared/injections'
import type { Site } from '../../shared/model'
import type { ScriptKind, ScriptLog, ScriptRun } from '../../shared/scripts'
import type { CaptureAccess } from '../capture/access'
import type { NotificationService } from '../notifications/service'
import type { DataStore } from '../storage/data-store'
import type { ConfigStore } from '../storage/store'
import type { ScriptPackageService } from './packages'
import type { ScriptLogStore, ScriptStore } from './store'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { bindingFingerprint, injectionBindingsSchema, INTERCEPT_TIMEOUT } from '../../shared/injections'
import { coerceVariables, logSchema, matchesUrl, MAX_LOGS, MAX_RUNS } from '../../shared/scripts'
import { SerialQueue } from '../storage/store'
import { dependenciesInstalled, scriptPackageDirectory } from './packages'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export class InjectionSession {
  readonly hooks = new Map<string, Hook>()
  readonly records = new Map<string, ScriptRun & { phase: InjectionState['phase'] }>()
  private pending = new Map<number, Pending>()
  private nextId = 0
  private worker: Worker
  private heartbeat: NodeJS.Timeout
  private lastBeat = Date.now()
  private initializing = 0
  private checkpoint?: NodeJS.Timeout
  private dead = false
  private stopping?: Promise<void>
  private installed = new Set<string>()
  private installing = new Map<string, Promise<void>>()
  private disposedTabs = new Set<string>()
  constructor(readonly site: Site, readonly fingerprint: string, readonly scripts: InjectionScript[], endpoint: string,
    private service: InjectionService, private warn: (text: string) => void,
    spawn: (input: InjectionWorkerInput) => Worker = (input) => new Worker(path.join(__dirname, 'injection-worker.js'), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 } }), connectionOptions?: BrowserConnectionOptions) {
    for (const { script } of scripts) {
      this.records.set(script.id, {
        id: randomUUID(), kind: 'injection', scriptId: script.id, scriptName: script.draft.name, revision: script.updatedAt,
        siteId: site.id, siteName: site.name, tabId: site.id, url: site.url, startedAt: new Date().toISOString(), status: 'running', phase: 'initializing', logs: [], droppedLogs: 0
      })
    }
    this.worker = spawn({ endpoint, site: { id: site.id, name: site.name, url: site.url }, scripts, connectionOptions })
    this.worker.on('message', (message: InjectionMessage) => this.message(message))
    this.worker.on('error', (error) => this.fail(`注入 Worker 异常：${error.message}`))
    this.worker.on('exit', (code) => { if (!this.dead) this.fail(`注入 Worker 意外退出（${code}）`) })
    this.heartbeat = setInterval(() => { if (!this.initializing && Date.now() - this.lastBeat > INTERCEPT_TIMEOUT) this.fail('注入 Worker 无响应，已停用本次会话的全部注入') }, 1000)
  }
  states(): InjectionState[] {
    return [...this.records.values()].map((run) => ({ scriptId: run.scriptId, name: run.scriptName, revision: run.revision, runId: run.id, phase: run.phase!, error: run.error }))
  }
  private message(message: InjectionMessage) {
    if (this.dead) return
    if (message.type === 'heartbeat') { this.lastBeat = Date.now(); return }
    if (message.type === 'notify') {
      const run = this.records.get(message.scriptId)
      if (!this.stopping && run && run.phase !== 'disabled' && !this.disposedTabs.has(message.tabId)) this.service.notifications?.submit(message.request, { kind: 'injection', scriptId: run.scriptId, runId: run.id, siteId: this.site.id, tabId: message.tabId })
    } else if (message.type === 'reply') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value)
    } else if (message.type === 'capture') {
      const run = this.records.get(message.scriptId)
      const active = () => Boolean(run && !this.dead && !this.stopping && run.phase !== 'disabled' && !this.disposedTabs.has(message.tabId))
      if (run && this.service.captureAccess) this.service.captureAccess.handle(message, { kind: 'injection', scriptId: run.scriptId, siteId: this.site.id }, active, (reply) => this.worker.postMessage({ type: 'captureReply', reply }))
      else this.worker.postMessage({ type: 'captureReply', reply: { type: 'captureReply', id: message.id, ok: false, error: '抓包服务不可用或脚本已停止' } })
    } else if (message.type === 'data') {
      // 数据仓库请求：source 由主进程按运行上下文填充，脚本无法伪造。
      const { id } = message
      const run = this.records.get(message.scriptId)
      const reply = (payload: { ok: true; value: unknown } | { ok: false; error: string }) => { try { this.worker.postMessage({ type: 'dataReply', reply: { type: 'data-reply', id, ...payload } }) } catch { /* worker 可能已终止。 */ } }
      if (!run || this.dead || this.stopping || run.phase === 'disabled') { reply({ ok: false, error: '注入已停止，数据请求未处理' }); return }
      void (this.service.dataStore ? this.service.dataStore.dispatch(message.op, message.payload, { kind: 'injection', scriptId: run.scriptId, scriptName: run.scriptName, runId: run.id, siteId: this.site.id }) : Promise.reject(new Error('数据仓库不可用')))
        .then((value) => reply({ ok: true, value }), (error) => reply({ ok: false, error: String(error?.message || error).slice(0, 4000) }))
    } else if (message.type === 'hook') {
      if (!this.stopping && !this.disposedTabs.has(message.hook.tabId) && this.records.has(message.hook.scriptId) && this.records.get(message.hook.scriptId)?.phase !== 'disabled') this.hooks.set(message.hook.id, message.hook)
    } else if (message.type === 'unhook') {
      this.hooks.delete(message.id)
    } else if (message.type === 'log') {
      const parsed = logSchema.safeParse(message.log)
      if (parsed.success) this.append(message.scriptId, parsed.data)
    } else if (message.type === 'initialized') {
      const run = this.records.get(message.scriptId)
      if (run && run.phase !== 'disabled') {
        run.phase = 'active'; run.tabId = message.tabId
        this.append(run.scriptId, this.log('info', '注入已生效', message.tabId)); this.service.changed()
      }
    }
  }
  rpc(operation: WorkerOperation, timeout = INTERCEPT_TIMEOUT): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('注入运行时已停止'))
    if (this.pending.size >= 512) return Promise.reject(new Error('注入请求过多'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('注入处理超时')) }, Math.max(1, timeout))
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker.postMessage({ ...operation, id }) } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }
  async setNavigationTimeout(seconds: number) {
    if (!this.dead && !this.stopping) await this.rpc({ type: 'navigationTimeout', seconds })
  }
  async ready() {
    // 启动加载受就绪 RPC 的期限约束，运行心跳不能提前判定尚未就绪的 Worker 失联。
    this.initializing++
    try { await this.rpc({ type: 'ready' }, 15000) } catch (error) { this.fail(String(error)); throw error } finally { this.initializing--; this.lastBeat = Date.now() }
    await this.persist()
  }
  async install(tabId: string, targetId: string, currentUrl: string) {
    if (this.installed.has(targetId) || this.dead || this.stopping) return
    const pending = this.installing.get(targetId)
    if (pending) return pending
    const installation = this.installPage(tabId, targetId, currentUrl)
    this.installing.set(targetId, installation)
    try { await installation } finally { this.installing.delete(targetId) }
  }
  private async installPage(tabId: string, targetId: string, currentUrl: string) {
    this.initializing++
    try {
      for (const { script } of this.scripts) {
        if (this.records.get(script.id)?.phase === 'disabled') continue
        this.append(script.id, this.log('info', '正在初始化标签注入', tabId))
        await this.rpc({ type: 'install', scriptId: script.id, tabId, targetId, currentUrl }, script.draft.timeout * 1000)
      }
      this.installed.add(targetId)
    } catch (error) { this.fail(`注入初始化失败：${String(error)}`); throw error } finally { this.initializing--; this.lastBeat = Date.now() }
  }
  async disposeTab(tabId: string, targetId: string) {
    this.installed.delete(targetId)
    this.disposedTabs.add(tabId)
    for (const [id, hook] of this.hooks) {
      if (hook.tabId === tabId) this.hooks.delete(id)
    }
    if (this.dead) return
    try { await this.rpc({ type: 'dispose', tabId }, 3000) } catch (error) { this.fail(`注入清理失败：${String(error)}`) }
  }
  disable(scriptId: string, error: string) {
    const run = this.records.get(scriptId)
    if (!run || run.phase === 'disabled') return
    run.phase = 'disabled'; run.status = 'error'; run.error = error.slice(0, 4000); run.endedAt = new Date().toISOString()
    for (const [id, hook] of this.hooks) {
      if (hook.scriptId === scriptId) this.hooks.delete(id)
    }
    this.append(scriptId, this.log('error', error)); this.warn(`注入“${run.scriptName}”已停用：${error}`)
    if (!this.dead) void this.rpc({ type: 'disable', scriptId }, 3000).catch(() => this.fail('注入清理无响应，已停用全部注入'))
    this.service.changed()
  }
  notice(tabId: string, text: string) {
    for (const run of this.records.values()) {
      if (run.phase === 'active') this.append(run.scriptId, this.log('warn', text, tabId))
    }
  }
  private fail(error: string) {
    if (this.dead) return
    this.dead = true; clearInterval(this.heartbeat); this.hooks.clear()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(error)) }
    this.pending.clear()
    for (const run of this.records.values()) this.disable(run.scriptId, error)
    void this.worker.terminate().catch(() => undefined)
    void this.persist(); this.service.changed()
  }
  private log(level: ScriptLog['level'], text: string, tabId?: string): ScriptLog { return { time: new Date().toISOString(), level, text: text.slice(0, 2000), tabId } }
  private append(scriptId: string, log: ScriptLog) {
    const run = this.records.get(scriptId)
    if (!run) return
    if (run.logs.length >= MAX_LOGS) { run.logs.shift(); run.droppedLogs++ }
    run.logs.push(log)
    if (!this.checkpoint) this.checkpoint = setTimeout(() => { this.checkpoint = undefined; void this.persist() }, 500)
  }
  private async persist() { await Promise.all([...this.records.values()].map((run) => this.service.persist(run))) }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      this.hooks.clear()
      if (!this.dead) { try { await this.rpc({ type: 'shutdown' }, 3000) } catch { /* 强制终止作为清理兜底。 */ } }
      this.dead = true; clearInterval(this.heartbeat); clearTimeout(this.checkpoint)
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('网站已停止')) }
      this.pending.clear()
      await this.worker.terminate().catch(() => undefined)
      for (const run of this.records.values()) {
        if (run.phase !== 'disabled') { run.phase = 'stopped'; run.status = 'success'; run.endedAt = new Date().toISOString() }
        this.append(run.scriptId, this.log('info', '网站停止，注入资源已释放'))
      }
      clearTimeout(this.checkpoint); this.checkpoint = undefined
      await this.persist()
    })()
    return this.stopping
  }
}

export class InjectionService {
  private queue = new SerialQueue()
  private sessions = new Map<string, InjectionSession>()
  private unpersisted = new Map<string, ScriptRun>()
  persistenceError?: string
  constructor(readonly store: ScriptStore, private logs: ScriptLogStore, private config: ConfigStore, readonly changed: () => void, readonly notifications?: NotificationService, readonly dataStore?: DataStore, readonly captureAccess?: CaptureAccess, private packages?: ScriptPackageService) {}
  mutate<T>(operation: () => Promise<T>): Promise<T> { return this.queue.run(operation) }
  validate(bindings: InjectionBinding[], url: string): InjectionScript[] {
    const result: InjectionScript[] = []
    for (const binding of injectionBindingsSchema.parse(bindings)) {
      let name = binding.scriptId
      try {
        const script = this.store.get(binding.scriptId)
        name = script.draft.name
        if (script.draft.kind !== 'injection') throw new Error('只能绑定注入脚本')
        if (!matchesUrl(script.draft.match, url)) throw new Error('网站配置网址不在适用域名内')
        const values = coerceVariables(script.draft.variables, binding.values)
        if (binding.enabled) result.push({ script, values, moduleRoot: scriptPackageDirectory(this.store.directory, script.id, script.draft.kind) })
      } catch (error) { throw new Error(`注入“${name}”：${String(error)}`) }
    }
    return result
  }
  fingerprint(site: Site): string { return bindingFingerprint(site.injections, this.store.list()) }
  references(scriptId: string): string[] {
    return [...new Set([
      ...this.config.get().sites.filter((site) => site.injections.some((item) => item.scriptId === scriptId)).map((site) => site.name),
      ...[...this.sessions.values()].filter((session) => session.scripts.some((entry) => entry.script.id === scriptId)).map((session) => session.site.name)
    ])]
  }
  assertChange(scriptId: string, kind?: ScriptKind) {
    const references = this.references(scriptId)
    if (references.length && (kind === undefined || this.store.get(scriptId).draft.kind !== kind)) throw new Error(`请先解绑并停止引用网站：${references.join('、')}`)
  }
  session(siteId: string) { return this.sessions.get(siteId) }
  async begin(site: Site, endpoint: string, warn: (text: string) => void, connectionOptions?: BrowserConnectionOptions) {
    const scripts = this.validate(site.injections, site.url)
    if (!scripts.length) return
    for (const { script, moduleRoot } of scripts) {
      if (this.packages?.isInstalling(script.id)) throw new Error(`注入“${script.draft.name}”：依赖正在安装，请等待安装完成后再启动网站`)
      if (!await dependenciesInstalled(moduleRoot, script.draft.dependencies)) throw new Error(`注入“${script.draft.name}”：依赖尚未安装或已变更，请先手动安装成功后再启动网站`)
    }
    const session = new InjectionSession(structuredClone(site), this.fingerprint(site), scripts, endpoint, this, warn, undefined, connectionOptions)
    this.sessions.set(site.id, session)
    await session.ready()
    return session
  }
  async stop(siteId: string) {
    const session = this.sessions.get(siteId)
    if (!session) return
    await session.stop()
    if (this.sessions.get(siteId) === session) this.sessions.delete(siteId)
    this.changed()
  }
  records(scriptId: string): ScriptRun[] {
    return structuredClone([...this.unpersisted.values(), ...[...this.sessions.values()].flatMap((session) => [...session.records.values()])].filter((run) => run.scriptId === scriptId))
  }
  active(scriptId: string) { return [...this.sessions.values()].some((session) => session.records.has(scriptId)) }
  async persist(run: ScriptRun) {
    try { await this.logs.put(run); this.unpersisted.delete(run.id) } catch {
      this.unpersisted.set(run.id, structuredClone(run))
      if (this.unpersisted.size > MAX_RUNS) this.unpersisted.delete(this.unpersisted.keys().next().value!)
      this.persistenceError = '注入日志保存失败，最近记录暂存在内存，请检查磁盘权限与空间。'; this.changed()
    }
  }
  forget(scriptId: string) {
    for (const [id, run] of this.unpersisted) {
      if (run.scriptId === scriptId) this.unpersisted.delete(id)
    }
  }
}
