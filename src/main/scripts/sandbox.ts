import type { EventEmitter } from 'node:events'
import type { SandboxCommand, SandboxInput } from '../../shared/sandbox'
import type { ActiveScriptRun, SavedScript, ScriptLog, ScriptRun, ScriptValues } from '../../shared/scripts'
import type { CaptureAccess } from '../capture/access'
import type { NotificationService } from '../notifications/service'
import type { DataStore } from '../storage/data-store'
import type { ScriptPackageService } from './packages'
import type { ScriptLogStore, ScriptStore } from './store'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { MAX_SANDBOXES, sandboxMessageSchema, serializeSandboxOutput } from '../../shared/sandbox'
import { coerceVariables, MAX_LOGS, MAX_RUNS } from '../../shared/scripts'
import { SerialQueue } from '../storage/store'
import { dependenciesInstalled, scriptPackageDirectory } from './packages'

export type SandboxProcess = EventEmitter & {
  pid?: number; stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null
  postMessage(message: SandboxCommand): void; kill(): boolean
}
export type SandboxSpawn = (input: SandboxInput, cwd: string) => Promise<SandboxProcess> | SandboxProcess
const spawnDefault: SandboxSpawn = async (_input, cwd) => {
  const { utilityProcess } = await import('electron')
  return utilityProcess.fork(path.join(__dirname, 'sandbox-process.js'), [], {
    cwd, stdio: 'pipe', serviceName: 'Octo Fetch 沙箱',
    // 不自动传递开发环境中的凭据；这并非进程或文件访问的权限隔离。
    env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  })
}
type Job = {
  run: ScriptRun; child: SandboxProcess; exited: boolean; exit: Promise<void>; disposed: Promise<void>; onDisposed(): void
  timer?: NodeJS.Timeout; checkpoint?: NodeJS.Timeout; persisting?: Promise<void>; dirty?: boolean; finishing?: Promise<void>; pendingResult?: string
  stdoutWindow: number; stdoutCount: number
}
async function waitFor(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(resolve, ms, false) })]) } finally { clearTimeout(timer) }
}
export class SandboxService {
  private queue = new SerialQueue()
  private jobs = new Map<string, Job>()
  private unpersisted = new Map<string, ScriptRun>()
  private closing = false
  persistenceError?: string
  constructor(private store: ScriptStore, private logs: ScriptLogStore, private changed: () => void, private packages: ScriptPackageService, private spawn: SandboxSpawn = spawnDefault, private notifications?: NotificationService, private dataStore?: DataStore, private captureAccess?: CaptureAccess) {}
  active(): ActiveScriptRun[] {
    return [...this.jobs.values()].map(({ run }) => ({ id: run.id, scriptId: run.scriptId, startedAt: run.startedAt, kind: run.kind, sandbox: run.sandbox, phase: run.phase }))
  }
  records(id: string): ScriptRun[] {
    return [...this.unpersisted.values(), ...[...this.jobs.values()].map((job) => job.run)].filter((run) => run.scriptId === id)
  }
  has(id: string) { return this.jobs.has(id) }
  forget(id: string) {
    for (const [key, run] of this.unpersisted) {
      if (run.scriptId === id) this.unpersisted.delete(key)
    }
  }
  start(saved: SavedScript, supplied: ScriptValues): Promise<ActiveScriptRun> {
    return this.queue.run(async () => {
      if (this.closing) throw new Error('应用正在退出')
      if (this.packages.isInstalling(saved.id)) throw new Error('该沙箱正在安装依赖，请等待完成')
      if (this.active().some((run) => run.scriptId === saved.id)) throw new Error('该沙箱已运行，请先停止')
      if (this.jobs.size >= MAX_SANDBOXES) throw new Error(`最多同时运行 ${MAX_SANDBOXES} 个沙箱`)
      if (saved.draft.kind !== 'sandbox' || !saved.draft.sandbox) throw new Error('不是沙箱脚本')
      const cwd = scriptPackageDirectory(this.store.directory, saved.id, saved.draft.kind)
      if (!await dependenciesInstalled(cwd, saved.draft.dependencies)) throw new Error('依赖尚未安装或已变更，请先手动安装成功后再启动脚本')
      const values = coerceVariables(saved.draft.variables, supplied)
      const run: ScriptRun = {
        id: randomUUID(), kind: 'sandbox', sandbox: { mode: saved.draft.sandbox.mode }, phase: 'initializing',
        scriptId: saved.id, scriptName: saved.draft.name, revision: saved.updatedAt,
        startedAt: new Date().toISOString(), status: 'running', logs: [], droppedLogs: 0
      }
      await mkdir(cwd, { recursive: true })
      await this.store.remember(saved.id, saved.updatedAt, values)
      await this.logs.put(run)
      const input: SandboxInput = { runId: run.id, scriptId: saved.id, source: saved.draft.source, values, mode: saved.draft.sandbox.mode }
      let child: SandboxProcess
      try { child = await this.spawn(input, cwd) } catch (error) {
        run.status = 'error'; run.phase = 'stopped'; run.endReason = 'error'; run.endedAt = new Date().toISOString(); run.error = `无法启动沙箱：${String(error)}`.slice(0, 4000)
        await this.persist(run); this.changed(); throw error
      }
      let onExit!: () => void, onDisposed!: () => void
      const job: Job = {
        run, child, exited: false, exit: new Promise((resolve) => { onExit = resolve }),
        disposed: new Promise((resolve) => { onDisposed = resolve }), onDisposed: () => onDisposed(),
        stdoutWindow: Date.now(), stdoutCount: 0
      }
      this.jobs.set(run.id, job)
      child.on('message', (raw: unknown) => this.message(job, raw))
      child.on('exit', (code: number) => {
        job.exited = true; onExit()
        if (!job.finishing) this.end(job, 'error', 'error', `沙箱进程意外退出（${code}）`)
      })
      child.on('error', (error: unknown) => this.end(job, 'error', 'error', `沙箱进程错误：${String(error)}`))
      this.capture(job, child.stdout, 'info'); this.capture(job, child.stderr, 'error')
      child.once('spawn', () => {
        if (!job.finishing) {
          try { child.postMessage({ type: 'start', input }) } catch (error) { this.end(job, 'error', 'error', String(error)) }
        }
      })
      job.timer = setTimeout(() => this.end(job, 'timeout', 'timeout', input.mode === 'service' ? '沙箱初始化超时' : '沙箱执行超时'), saved.draft.timeout * 1000)
      this.append(job, 'info', `开始执行“${run.scriptName}” · 独立 Node.js · ${input.mode === 'service' ? '常驻' : '一次性'}`)
      this.changed()
      return this.active().find((item) => item.id === run.id)!
    })
  }
  private message(job: Job, raw: unknown) {
    const parsed = sandboxMessageSchema.safeParse(raw)
    if (!parsed.success || parsed.data.runId !== job.run.id || job.exited) return
    const message = parsed.data
    if (message.type === 'notify') {
      if (!job.finishing) this.notifications?.submit(message.request, { kind: 'sandbox', scriptId: job.run.scriptId, runId: job.run.id })
      return
    }
    if (message.type === 'capture') {
      const active = () => !job.finishing && !job.exited && this.jobs.get(job.run.id) === job
      if (this.captureAccess) this.captureAccess.handle(message, { kind: 'sandbox', scriptId: job.run.scriptId }, active, (reply) => job.child.postMessage({ type: 'captureReply', runId: job.run.id, reply }))
      else job.child.postMessage({ type: 'captureReply', runId: job.run.id, reply: { type: 'captureReply', id: message.id, ok: false, error: '抓包服务不可用' } })
      return
    }
    if (message.type === 'data') {
      // 数据仓库请求：source 由主进程按运行上下文填充，脚本无法伪造。
      const { id } = message
      const reply = (payload: { ok: true; value: unknown } | { ok: false; error: string }) => { try { job.child.postMessage({ type: 'dataReply', runId: job.run.id, reply: { type: 'data-reply', id, ...payload } }) } catch { /* 进程可能已退出。 */ } }
      void (this.dataStore ? this.dataStore.dispatch(message.op, message.payload, { kind: 'sandbox', scriptId: job.run.scriptId, scriptName: job.run.scriptName, runId: job.run.id }) : Promise.reject(new Error('数据仓库不可用')))
        .then((value) => reply({ ok: true, value }), (error) => reply({ ok: false, error: String(error?.message || error).slice(0, 4000) }))
      return
    }
    for (const log of message.logs) this.appendLog(job, log)
    job.run.droppedLogs = Math.min(Number.MAX_SAFE_INTEGER, job.run.droppedLogs + message.dropped)
    if (message.result !== undefined && (!job.finishing || job.run.sandbox?.mode === 'service')) {
      try {
        const result = serializeSandboxOutput(JSON.parse(message.result))
        if (job.run.sandbox?.mode === 'service') job.run.result = result
        else if (message.type === 'done') job.pendingResult = result
      } catch { this.end(job, 'error', 'error', '沙箱输出不是有效的 JSON 结果'); return }
    }
    if (message.type === 'disposed') job.onDisposed()
    if (message.type === 'batch') {
      try { job.child.postMessage({ type: 'ack', runId: job.run.id }) } catch { /* 退出时可能已经关闭通信。 */ }
    }
    if (job.finishing) return
    this.checkpoint(job)
    if (message.type === 'ready' || message.type === 'done') {
      if ((message.type === 'ready') !== (job.run.sandbox?.mode === 'service') || job.run.phase !== 'initializing') return
      job.run.nodeVersion = message.nodeVersion
      if (message.type === 'ready') {
        clearTimeout(job.timer); job.run.phase = 'active'; this.append(job, 'info', '初始化完成，沙箱持续运行'); this.changed()
      } else {
        this.end(job, 'success', 'completed')
      }
    } else if (message.type === 'failed') {
      this.end(job, 'error', 'error', message.error)
    }
  }
  private capture(job: Job, stream: NodeJS.ReadableStream | null, level: ScriptLog['level']) {
    if (!stream) return
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const emit = (text: string) => {
      if (Date.now() - job.stdoutWindow >= 1000) { job.stdoutWindow = Date.now(); job.stdoutCount = 0 }
      if (++job.stdoutCount > 100) { job.run.droppedLogs = Math.min(Number.MAX_SAFE_INTEGER, job.run.droppedLogs + 1); return }
      this.append(job, level, text)
    }
    stream.on('data', (chunk: Buffer) => {
      // 持续消费管道，每段最多缓存 2000 字符；超长且无换行的输出同样有界。
      const text = decoder.write(chunk)
      let offset = 0
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset)
        const end = Math.min(newline < 0 ? text.length : newline, offset + 2000 - pending.length)
        pending += text.slice(offset, end); offset = end
        if (offset === newline) { emit(pending); pending = ''; offset++ } else if (pending.length >= 2000) { emit(pending); pending = '' }
      }
    })
    const flush = () => { if (pending) emit(pending.slice(0, 2000)); pending = '' }
    const timer = setInterval(flush, 500)
    job.child.once('exit', () => { clearInterval(timer); flush() })
    stream.on('end', () => { clearInterval(timer); pending += decoder.end(); flush() })
    stream.on('error', () => this.append(job, 'warn', '沙箱输出管道读取失败'))
  }
  private append(job: Job, level: ScriptLog['level'], text: string) {
    this.appendLog(job, { time: new Date().toISOString(), level, text: text.slice(0, 2000) })
  }
  private appendLog(job: Job, log: ScriptLog) {
    if (job.run.logs.length >= MAX_LOGS) { job.run.logs.shift(); job.run.droppedLogs = Math.min(Number.MAX_SAFE_INTEGER, job.run.droppedLogs + 1) }
    job.run.logs.push(log); this.checkpoint(job)
  }
  private checkpoint(job: Job) {
    if (job.finishing) return
    job.dirty = true
    if (!job.checkpoint && !job.persisting) {
      job.checkpoint = setTimeout(() => {
        job.checkpoint = undefined; job.dirty = false
        if (!job.finishing) {
          job.persisting = this.persist(job.run).finally(() => {
            job.persisting = undefined
            if (job.dirty) this.checkpoint(job)
          })
        }
      }, 500)
    }
  }
  private async persist(run: ScriptRun) {
    try { await this.logs.put(run); this.unpersisted.delete(run.id) } catch {
      this.unpersisted.set(run.id, structuredClone(run))
      if (this.unpersisted.size > MAX_RUNS) this.unpersisted.delete(this.unpersisted.keys().next().value!)
      this.persistenceError = '沙箱日志写入失败，请检查数据目录权限或磁盘空间；最近记录暂存于内存。'; this.changed()
    }
  }
  private end(job: Job, status: ScriptRun['status'], reason: ScriptRun['endReason'], error?: string) {
    void this.finish(job, status, reason, error).catch(() => undefined)
  }
  private finish(job: Job, status: ScriptRun['status'], reason: ScriptRun['endReason'], error?: string): Promise<void> {
    if (job.finishing) return job.finishing
    job.finishing = Promise.resolve().then(async () => {
      clearTimeout(job.timer); clearTimeout(job.checkpoint)
      job.run.phase = 'stopping'; this.changed()
      if (!job.exited) {
        try { job.child.postMessage({ type: 'stop', runId: job.run.id }) } catch { /* 进程可能已退出。 */ }
        await waitFor(Promise.race([job.disposed, job.exit]), 3000)
        if (!job.exited) {
          job.child.kill()
          if (!await waitFor(job.exit, 500) && job.child.pid !== undefined) {
            // 只有仍由该句柄拥有且尚未发出 exit 的 PID 才允许升级终止。
            try { process.kill(job.child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
          }
          if (!await waitFor(job.exit, 2000)) throw new Error('无法确认沙箱进程退出，请再次停止')
        }
      }
      job.run.phase = 'stopped'; job.run.status = status; job.run.endReason = reason; job.run.endedAt = new Date().toISOString()
      if (error) job.run.error = error.slice(0, 4000)
      if (job.run.sandbox?.mode === 'once') {
        if (status === 'success') job.run.result = job.pendingResult
        else delete job.run.result
      }
      this.append(job, status === 'error' || status === 'timeout' ? 'error' : 'info', error || (status === 'success' ? '执行完成' : reason === 'shutdown' ? '应用退出，沙箱已停止' : '沙箱已停止'))
      await job.persisting
      await this.persist(job.run)
      this.jobs.delete(job.run.id); this.changed()
    }).catch(async (error) => {
      job.finishing = undefined
      this.append(job, 'error', String(error)); await this.persist(job.run); this.changed()
      throw error
    })
    return job.finishing
  }
  async cancel(id: string) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('运行已结束或不存在')
    await this.finish(job, 'cancelled', 'user')
  }
  async shutdown() {
    this.closing = true
    await this.queue.run(async () => { await Promise.all([...this.jobs.values()].map((job) => this.finish(job, 'cancelled', 'shutdown'))) })
  }
}
