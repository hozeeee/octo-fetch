import type { BrowserConnectionOptions } from '../../shared/browser-options'
import type { CaptureRequest } from '../../shared/capture'
import type { DataOp } from '../../shared/data-store'
import type { NotifyWorkerMessage } from '../../shared/notifications'
import type { ActiveScriptRun, SavedScript, ScriptDraft, ScriptLog, ScriptRun, ScriptRunRequest, ScriptValues } from '../../shared/scripts'
import type { BrowserManager } from '../browser/manager'
import type { CaptureAccess } from '../capture/access'
import type { NotificationService } from '../notifications/service'
import type { DataStore } from '../storage/data-store'
import type { PackageInstaller } from './packages'
import type { SandboxSpawn } from './sandbox'
import type { ScriptLogStore, ScriptStore } from './store'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { coerceVariables, logSchema, matchesUrl, MAX_LOGS, MAX_OUTPUT, MAX_RUNS, runRequestSchema } from '../../shared/scripts'
import { withTimeout } from '../browser/manager'
import { SerialQueue } from '../storage/store'
import { dependenciesInstalled, scriptPackageDirectory, ScriptPackageService } from './packages'
import { SandboxService } from './sandbox'

export type WorkerInput = {
  endpoint: string; targetId: string; scriptId: string; moduleRoot: string; source: string; timeout: number; match: string[]; values: ScriptValues; connectionOptions?: BrowserConnectionOptions
  site: { id: string; name: string; url: string; tabId: string; currentUrl: string }
}
export type WorkerMessage = CaptureRequest | NotifyWorkerMessage | { type: 'data'; id: string; op: DataOp; payload: unknown } | { type: 'log'; log: ScriptLog } | { type: 'done'; result?: string; dropped: number } | { type: 'failed'; error: string; dropped: number }
type Job = { run: ScriptRun; worker: Worker; timer?: NodeJS.Timeout; checkpoint?: NodeJS.Timeout; finishing?: Promise<void> }
export class ScriptRunner {
  private queue = new SerialQueue()
  private jobs = new Map<string, Job>()
  private unpersisted = new Map<string, ScriptRun>()
  // 任务编排逐步执行时用 startAndWait 等待某次行动跑完；键为 run.id。
  private waiters = new Map<string, (run: ScriptRun) => void>()
  private closing = false
  persistenceError?: string
  constructor(readonly store: ScriptStore, readonly logs: ScriptLogStore, private manager: BrowserManager,
    private changed: () => void, private spawn: (input: WorkerInput) => Worker = (input) => new Worker(path.join(__dirname, 'script-worker.js'), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 } }), readonly notifications?: NotificationService, sandboxSpawn?: SandboxSpawn, readonly dataStore?: DataStore, readonly captureAccess?: CaptureAccess, packageInstaller?: PackageInstaller) {
    this.packages = new ScriptPackageService(store.directory, packageInstaller)
    this.sandbox = new SandboxService(store, logs, changed, this.packages, sandboxSpawn, notifications, dataStore, captureAccess)
  }
  readonly packages: ScriptPackageService
  readonly sandbox: SandboxService
  active(): ActiveScriptRun[] {
    return [...[...this.jobs.values()].map(({ run }) => ({ id: run.id, kind: run.kind, scriptId: run.scriptId, siteId: run.siteId, startedAt: run.startedAt })), ...this.sandbox.active()]
  }
  save(id: string | undefined, draft: ScriptDraft, origin: SavedScript['origin']) {
    return this.queue.run(async () => {
      if (id && this.packages.isInstalling(id)) throw new Error('依赖安装中，暂不能编辑该脚本')
      if (id && this.active().some((run) => run.scriptId === id)) throw new Error('请先停止该脚本再编辑')
      const operation = async () => {
        if (id) this.manager.injections?.assertChange(id, draft.kind || 'action')
        if (id && this.store.get(id).draft.kind !== (draft.kind || 'action')) await this.manager.captureService?.grant(id, 'none')
        return this.store.save(id, draft, origin)
      }
      return this.manager.injections ? this.manager.injections.mutate(operation) : operation()
    })
  }
  remove(id: string): Promise<void> {
    return this.queue.run(async () => {
      if (this.packages.isInstalling(id)) throw new Error('依赖安装中，暂不能删除该脚本')
      if (this.active().some((run) => run.scriptId === id)) throw new Error('请先停止该脚本再删除')
      const operation = async () => {
        this.manager.injections?.assertChange(id)
        await this.store.remove(id)
        await this.manager.captureService?.grant(id, 'none')
        await this.logs.clear(id)
        this.manager.injections?.forget(id)
      }
      if (this.manager.injections) await this.manager.injections.mutate(operation); else await operation()
      this.sandbox.forget(id)
      for (const [key, run] of this.unpersisted) {
        if (run.scriptId === id) this.unpersisted.delete(key)
      }
    })
  }
  clearLogs(id: string): Promise<void> {
    return this.queue.run(async () => {
      this.store.get(id)
      if (this.active().some((run) => run.scriptId === id) || this.manager.injections?.active(id)) throw new Error('运行中的日志不能清空')
      await this.logs.clear(id)
      this.manager.injections?.forget(id)
      this.sandbox.forget(id)
      for (const [key, run] of this.unpersisted) {
        if (run.scriptId === id) this.unpersisted.delete(key)
      }
    })
  }
  async runs(id: string): Promise<ScriptRun[]> {
    this.store.get(id)
    const records = new Map((await this.logs.list(id)).map((run) => [run.id, run]))
    for (const run of this.unpersisted.values()) {
      if (run.scriptId === id) records.set(run.id, run)
    }
    for (const { run } of this.jobs.values()) {
      if (run.scriptId === id) records.set(run.id, run)
    }
    for (const run of this.manager.injections?.records(id) || []) records.set(run.id, run)
    for (const run of this.sandbox.records(id)) records.set(run.id, run)
    return structuredClone([...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS))
  }
  async installDependencies(id: string) {
    const reserved = await this.queue.run(async () => {
      const saved = this.store.get(id)
      if (this.active().some((run) => run.scriptId === id) || this.manager.injections?.active(id)) throw new Error('请先停止该脚本或引用网站再安装依赖')
      const registry = this.manager.store.get().settings.sandboxRegistry
      return { promise: this.packages.install(saved, registry) }
    })
    return reserved.promise
  }
  start(raw: ScriptRunRequest): Promise<ActiveScriptRun> {
    const request = runRequestSchema.parse(raw)
    return this.queue.run(async () => {
      if (this.closing) throw new Error('应用正在退出')
      const saved = this.store.get(request.scriptId)
      if (this.packages.isInstalling(saved.id)) throw new Error('该脚本正在安装依赖，请等待完成')
      if (saved.draft.kind === 'sandbox') {
        if (request.siteId !== undefined || request.tabId !== undefined) throw new Error('沙箱不能指定网站或标签')
        return this.sandbox.start(saved, request.values)
      }
      if (saved.draft.kind !== 'action') throw new Error('注入不能作为行动运行，请在页面管理中绑定并重启网站')
      if (!request.siteId) throw new Error('行动脚本必须选择网站')
      if ([...this.jobs.values()].some(({ run }) => run.siteId === request.siteId)) throw new Error('该网站已有脚本运行，请等待结束或取消')
      const moduleRoot = scriptPackageDirectory(this.store.directory, saved.id, saved.draft.kind)
      if (!await dependenciesInstalled(moduleRoot, saved.draft.dependencies)) throw new Error('依赖尚未安装或已变更，请先手动安装成功后再启动脚本')
      const values = coerceVariables(saved.draft.variables, request.values)
      const session = await withTimeout(this.manager.scriptSession(request.siteId, request.tabId), 10000)
      if (!matchesUrl(saved.draft.match, session.site.currentUrl)) throw new Error('当前标签域名不适用此脚本，请选择匹配的标签')
      const run: ScriptRun = {
        id: randomUUID(), kind: 'action', scriptId: saved.id, scriptName: saved.draft.name, revision: saved.updatedAt,
        siteId: request.siteId, siteName: session.site.name, tabId: session.site.tabId, url: session.site.currentUrl,
        startedAt: new Date().toISOString(), status: 'running', logs: [], droppedLogs: 0
      }
      await this.store.remember(saved.id, saved.updatedAt, values)
      await this.logs.put(run)
      let worker: Worker
      try { worker = this.spawn({ ...session, scriptId: saved.id, moduleRoot, source: saved.draft.source, match: saved.draft.match, timeout: saved.draft.timeout, values }) } catch (error) {
        run.status = 'error'; run.error = `无法启动脚本 Worker：${String(error)}`.slice(0, 4000); run.endedAt = new Date().toISOString()
        await this.persist(run); throw error
      }
      const job: Job = { run, worker }
      this.jobs.set(run.id, job)
      this.append(job, { time: run.startedAt, level: 'info', text: `开始执行“${run.scriptName}” · ${run.siteName}` })
      worker.on('message', (message: WorkerMessage) => {
        if (job.finishing) return
        if (message.type === 'notify') {
          this.notifications?.submit(message.request, { kind: 'action', scriptId: run.scriptId, runId: run.id, siteId: run.siteId, tabId: run.tabId })
        } else if (message.type === 'capture') {
          const active = () => !job.finishing && this.jobs.get(run.id) === job
          if (this.captureAccess) this.captureAccess.handle(message, { kind: 'action', scriptId: run.scriptId, siteId: run.siteId }, active, (reply) => worker.postMessage(reply))
          else worker.postMessage({ type: 'captureReply', id: message.id, ok: false, error: '抓包服务不可用' })
        } else if (message.type === 'data') {
          // 数据仓库请求：source 由主进程按运行上下文填充，脚本无法伪造。
          const { id } = message
          void (this.dataStore ? this.dataStore.dispatch(message.op, message.payload, { kind: 'action', scriptId: run.scriptId, scriptName: run.scriptName, runId: run.id, siteId: run.siteId }) : Promise.reject(new Error('数据仓库不可用')))
            .then((value) => job.worker.postMessage({ type: 'data-reply', id, ok: true, value }))
            .catch((error) => job.worker.postMessage({ type: 'data-reply', id, ok: false, error: String(error?.message || error).slice(0, 4000) }))
        } else if (message.type === 'log') {
          const parsed = logSchema.safeParse(message.log)
          if (parsed.success) this.append(job, parsed.data)
        } else if (message.type === 'done' || message.type === 'failed') {
          run.droppedLogs += Math.max(0, Math.min(Number.isFinite(message.dropped) ? message.dropped : 0, Number.MAX_SAFE_INTEGER - run.droppedLogs))
          if (message.type === 'done') {
            if (message.result !== undefined) run.result = String(message.result).slice(0, MAX_OUTPUT)
            void this.finish(job, 'success')
          } else {
            void this.finish(job, 'error', message.error)
          }
        }
      })
      worker.on('error', (error) => { void this.finish(job, 'error', error.message) })
      worker.on('exit', (code) => { if (!job.finishing) void this.finish(job, 'error', `执行进程意外退出（${code}）`) })
      job.timer = setTimeout(() => { void this.finish(job, 'timeout', '脚本执行超时，已终止执行进程；已发起的网页操作无法回滚') }, saved.draft.timeout * 1000)
      this.changed()
      return { id: run.id, kind: run.kind, scriptId: run.scriptId, siteId: run.siteId, startedAt: run.startedAt }
    })
  }
  // 启动一次行动并等待其终态；供任务编排串行驱动步骤。start 同步抛错时直接拒绝。
  async startAndWait(request: ScriptRunRequest): Promise<ScriptRun> {
    const active = await this.start(request)
    return new Promise<ScriptRun>((resolve) => { this.waiters.set(active.id, resolve) })
  }
  private append(job: Job, log: ScriptLog) {
    if (job.run.logs.length >= MAX_LOGS) { job.run.logs.shift(); job.run.droppedLogs++ }
    job.run.logs.push(log)
    if (!job.checkpoint) {
      job.checkpoint = setTimeout(() => {
        job.checkpoint = undefined
        if (!job.finishing) void this.persist(job.run)
      }, 500)
    }
  }
  private async persist(run: ScriptRun): Promise<void> {
    try { await this.logs.put(run); this.unpersisted.delete(run.id) } catch {
      this.unpersisted.set(run.id, structuredClone(run))
      if (this.unpersisted.size > MAX_RUNS) this.unpersisted.delete(this.unpersisted.keys().next().value!)
      this.persistenceError = '脚本日志写入失败，请检查数据目录权限或磁盘空间；最近记录暂存于内存。'
      this.changed()
    }
  }
  private finish(job: Job, status: ScriptRun['status'], error?: string): Promise<void> {
    if (job.finishing) return job.finishing
    job.finishing = Promise.resolve().then(async () => {
      clearTimeout(job.timer); clearTimeout(job.checkpoint)
      try { job.worker.postMessage({ type: 'captureClose' }) } catch { /* Worker 可能已退出。 */ }
      await job.worker.terminate().catch(() => undefined)
      job.run.status = status; job.run.endedAt = new Date().toISOString()
      if (error) job.run.error = String(error).slice(0, 4000)
      if (job.run.logs.length >= MAX_LOGS) { job.run.logs.shift(); job.run.droppedLogs++ }
      job.run.logs.push({ time: job.run.endedAt, level: status === 'success' ? 'info' : 'error', text: (error || '执行完成').slice(0, 2000) })
      await this.persist(job.run)
      this.jobs.delete(job.run.id); this.changed()
      const waiter = this.waiters.get(job.run.id)
      if (waiter) { this.waiters.delete(job.run.id); waiter(structuredClone(job.run)) }
    })
    return job.finishing
  }
  async cancel(id: string): Promise<void> {
    z.uuid().parse(id)
    if (this.sandbox.has(id)) return this.sandbox.cancel(id)
    const job = this.jobs.get(id)
    if (!job) throw new Error('运行已结束或不存在')
    await this.finish(job, 'cancelled', '用户取消执行；已发起的网页操作无法回滚')
  }
  async shutdown(): Promise<void> {
    this.closing = true
    await this.queue.run(async () => {
      await Promise.all([this.packages.shutdown(), this.sandbox.shutdown(), ...[...this.jobs.values()].map((job) => this.finish(job, 'cancelled', '应用退出，执行已取消'))])
    })
  }
}
