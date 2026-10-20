import type { ActiveTaskRun, SavedTask, TaskDraft, TaskRun, TaskRunStep } from '../../shared/tasks'
import type { ScriptRunner } from '../scripts/runner'
import type { ConfigStore } from '../storage/store'
import type { TaskLogStore } from './store'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cronNext, validateCron } from '../../shared/cron'
import { coerceVariables } from '../../shared/scripts'
import {
  MAX_TASKS, resolveStepValues,
  taskDraftSchema
} from '../../shared/tasks'
import { SerialQueue } from '../storage/store'

// 每 ~20 秒巡检一次到点的定时任务；应用重启后不补跑关闭期间错过的计划。
const TICK_INTERVAL = 20000

export class TaskService {
  private queue = new SerialQueue()
  // 同一任务同时只允许一个运行，键为 taskId。
  private runs = new Map<string, TaskRun>()
  private cancelling = new Set<string>()
  private timer?: NodeJS.Timeout
  private ticking = false
  private closing = false
  private startedAt = 0
  persistenceError?: string
  constructor(private config: ConfigStore, private scripts: ScriptRunner, private logs: TaskLogStore, private changed: () => void) {}

  list(): SavedTask[] {
    return this.config.get().tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  get(id: string): SavedTask {
    const task = this.config.get().tasks.find((item) => item.id === z.uuid().parse(id))
    if (!task) throw new Error('任务不存在')
    return task
  }
  active(): ActiveTaskRun[] {
    return [...this.runs.values()].map((run) => ({ id: run.id, taskId: run.taskId, startedAt: run.startedAt }))
  }

  save(id: string | undefined, rawDraft: TaskDraft, origin: SavedTask['origin']): Promise<SavedTask> {
    const draft = taskDraftSchema.parse(rawDraft)
    return this.queue.run(async () => {
      if (id && this.runs.has(id)) throw new Error('请先停止该任务再编辑')
      const taskValues = coerceVariables(draft.variables, draft.values)
      draft.steps.forEach((step, index) => {
        let script
        try { script = this.scripts.store.get(step.scriptId) } catch { throw new Error(`步骤 ${index + 1} 的脚本不存在`) }
        if (script.draft.kind !== 'action') throw new Error(`步骤 ${index + 1} 必须选择行动脚本`)
        try { this.config.site(step.siteId) } catch { throw new Error(`步骤 ${index + 1} 的网站配置不存在`) }
        coerceVariables(script.draft.variables, resolveStepValues(script.draft.variables, taskValues, step))
      })
      let saved: SavedTask | undefined
      await this.config.update((config) => {
        const previous = id ? config.tasks.find((item) => item.id === id) : undefined
        if (id && !previous) throw new Error('任务不存在')
        if (!previous && config.tasks.length >= MAX_TASKS) throw new Error(`最多保留 ${MAX_TASKS} 个任务`)
        const now = new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt || '') || 0) + 1)).toISOString()
        saved = { id: previous?.id || randomUUID(), draft, origin, createdAt: previous?.createdAt || now, updatedAt: now, lastRunAt: previous?.lastRunAt, lastStatus: previous?.lastStatus }
        if (previous) Object.assign(previous, saved); else config.tasks.push(saved)
      })
      this.changed()
      return structuredClone(saved!)
    })
  }
  remove(id: string): Promise<void> {
    return this.queue.run(async () => {
      if (this.runs.has(id)) throw new Error('请先停止该任务再删除')
      await this.config.update((config) => {
        const index = config.tasks.findIndex((item) => item.id === id)
        if (index < 0) throw new Error('任务不存在')
        config.tasks.splice(index, 1)
      })
      await this.logs.clear(id)
      this.changed()
    })
  }
  enable(id: string, enabled: boolean): Promise<void> {
    return this.queue.run(async () => {
      const task = this.get(id)
      if (enabled) { const error = validateCron(task.draft.schedule.cron); if (error) throw new Error(`无法启用定时：${error}`) }
      await this.config.update((config) => {
        const target = config.tasks.find((item) => item.id === id)
        if (!target) throw new Error('任务不存在')
        target.draft.schedule.enabled = enabled
      })
      this.changed()
    })
  }
  clearLogs(id: string): Promise<void> {
    return this.queue.run(async () => {
      this.get(id)
      if (this.runs.has(id)) throw new Error('运行中的任务日志不能清空')
      await this.logs.clear(id)
      this.changed()
    })
  }
  async runsOf(id: string): Promise<TaskRun[]> {
    const records = new Map((await this.logs.list(z.uuid().parse(id))).map((run) => [run.id, run]))
    const active = this.runs.get(id)
    if (active) records.set(active.id, structuredClone(active))
    return [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  // 启动任务：登记运行态并落盘首帧后立即返回，随后在后台串行执行各步骤。
  async run(taskId: string, trigger: TaskRun['trigger']): Promise<ActiveTaskRun> {
    if (this.closing) throw new Error('应用正在退出')
    if (this.runs.has(taskId)) throw new Error('该任务已在运行中')
    const task = this.get(taskId)
    const startedAt = new Date().toISOString()
    const run: TaskRun = {
      id: randomUUID(), taskId, taskName: task.draft.name, revision: task.updatedAt, trigger, startedAt, status: 'running',
      steps: task.draft.steps.map((step, index) => {
        const script = this.scripts.store.list().find((item) => item.id === step.scriptId)
        return { index, scriptId: step.scriptId, scriptName: script?.draft.name || '未知脚本', siteId: step.siteId, siteName: this.siteName(step.siteId), status: 'pending' as TaskRunStep['status'] }
      })
    }
    this.runs.set(taskId, run)
    this.cancelling.delete(taskId)
    await this.persist(run)
    await this.config.update((config) => { const target = config.tasks.find((item) => item.id === taskId); if (target) target.lastRunAt = startedAt }).catch(() => undefined)
    this.changed()
    void this.execute(task, run)
    return { id: run.id, taskId, startedAt }
  }
  async cancel(taskId: string): Promise<void> {
    const run = this.runs.get(taskId)
    if (!run) throw new Error('任务未在运行')
    this.cancelling.add(taskId)
    const running = run.steps.find((step) => step.status === 'running')
    if (running?.scriptRunId) await this.scripts.cancel(running.scriptRunId).catch(() => undefined)
  }

  private siteName(siteId: string): string {
    return this.config.get().sites.find((site) => site.id === siteId)?.name || '未知网站'
  }
  private skipRemaining(run: TaskRun, from: number): void {
    for (let index = from; index < run.steps.length; index++) {
      if (run.steps[index].status === 'pending') run.steps[index].status = 'skipped'
    }
  }
  private async execute(task: SavedTask, run: TaskRun): Promise<void> {
    let cancelled = false, aborted = false, anyFailure = false
    try {
      const taskValues = coerceVariables(task.draft.variables, task.draft.values)
      for (let index = 0; index < task.draft.steps.length; index++) {
        if (this.cancelling.has(task.id)) { cancelled = true; this.skipRemaining(run, index); break }
        const step = task.draft.steps[index]
        const stepRun = run.steps[index]
        stepRun.status = 'running'; stepRun.startedAt = new Date().toISOString()
        await this.persist(run); this.changed()
        try {
          const script = this.scripts.store.get(step.scriptId)
          if (script.draft.kind !== 'action') throw new Error('步骤脚本不是行动脚本')
          const values = coerceVariables(script.draft.variables, resolveStepValues(script.draft.variables, taskValues, step))
          const scriptRun = await this.scripts.startAndWait({ scriptId: step.scriptId, siteId: step.siteId, values })
          stepRun.scriptRunId = scriptRun.id; stepRun.endedAt = new Date().toISOString()
          if (scriptRun.status === 'success') {
            stepRun.status = 'success'
          } else if (scriptRun.status === 'cancelled') { stepRun.status = 'cancelled'; stepRun.error = scriptRun.error } else { stepRun.status = 'error'; stepRun.error = scriptRun.error || `脚本运行${scriptRun.status}` }
        } catch (error) {
          stepRun.status = 'error'; stepRun.endedAt = new Date().toISOString(); stepRun.error = String(error instanceof Error ? error.message : error).slice(0, 4000)
        }
        await this.persist(run); this.changed()
        if (stepRun.status === 'cancelled' || this.cancelling.has(task.id)) { cancelled = true; this.skipRemaining(run, index + 1); break }
        if (stepRun.status === 'error') {
          anyFailure = true
          if (!step.optional && task.draft.onError === 'stop') { aborted = true; this.skipRemaining(run, index + 1); break }
        }
      }
    } catch (error) {
      // 任务级组装/校验失败：把仍待执行的步骤标记跳过，任务判为失败。
      aborted = true
      const current = run.steps.find((step) => step.status === 'running')
      if (current) { current.status = 'error'; current.endedAt = new Date().toISOString(); current.error = String(error instanceof Error ? error.message : error).slice(0, 4000) }
      this.skipRemaining(run, 0)
    }
    run.status = cancelled ? 'cancelled' : aborted ? 'error' : anyFailure ? 'partial' : 'success'
    run.endedAt = new Date().toISOString()
    await this.persist(run)
    await this.config.update((config) => { const target = config.tasks.find((item) => item.id === task.id); if (target) target.lastStatus = run.status }).catch(() => undefined)
    this.runs.delete(task.id)
    this.cancelling.delete(task.id)
    this.changed()
  }
  private async persist(run: TaskRun): Promise<void> {
    try { await this.logs.put(run) } catch { this.persistenceError = '任务运行记录写入失败，请检查数据目录权限或磁盘空间。'; this.changed() }
  }

  start(): void {
    this.startedAt = Date.now()
    this.timer = setInterval(() => { void this.tick() }, TICK_INTERVAL)
  }
  private async tick(): Promise<void> {
    if (this.closing || this.ticking) return
    this.ticking = true
    try {
      const now = new Date()
      for (const task of this.list()) {
        const schedule = task.draft.schedule
        if (!schedule.enabled || validateCron(schedule.cron) || this.runs.has(task.id)) continue
        const base = new Date(Math.max(this.startedAt, task.lastRunAt ? Date.parse(task.lastRunAt) : 0))
        const next = cronNext(schedule.cron, base)
        if (next && next.getTime() <= now.getTime()) await this.run(task.id, 'schedule').catch(() => undefined)
      }
    } finally { this.ticking = false }
  }
  async shutdown(): Promise<void> {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    for (const taskId of [...this.runs.keys()]) {
      this.cancelling.add(taskId)
      const running = this.runs.get(taskId)?.steps.find((step) => step.status === 'running')
      if (running?.scriptRunId) await this.scripts.cancel(running.scriptRunId).catch(() => undefined)
    }
    const deadline = Date.now() + 5000
    while (this.runs.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
