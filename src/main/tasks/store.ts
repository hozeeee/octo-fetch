import type { TaskRun } from '../../shared/tasks'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { MAX_TASK_RUNS, taskRunSchema } from '../../shared/tasks'
import { atomicWrite, SerialQueue } from '../storage/store'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

// 每个任务仅保留最近 20 次运行记录；结构与用途完全对应 ScriptLogStore。
export class TaskLogStore {
  private queue = new SerialQueue()
  private cache = new Map<string, TaskRun[]>()
  constructor(private directory: string) {}
  private file(id: string) { return path.join(this.directory, 'task-logs', `${z.uuid().parse(id)}.json`) }
  private async load(id: string): Promise<TaskRun[]> {
    if (this.cache.has(id)) return this.cache.get(id)!
    let records: TaskRun[]
    try { records = z.array(taskRunSchema).max(MAX_TASK_RUNS).parse(JSON.parse(await readFile(this.file(id), 'utf8'))) } catch (error) { if (!missing(error)) throw new Error('任务运行记录无法读取，原文件已保留'); records = [] }
    let recovered = false
    for (const run of records) {
      if (run.taskId !== id) throw new Error('任务运行记录所属任务不匹配')
      if (run.status === 'running') {
        run.status = 'interrupted'; run.endedAt = new Date().toISOString(); recovered = true
        for (const step of run.steps) {
          if (step.status === 'running') { step.status = 'cancelled'; step.endedAt = run.endedAt; step.error = '上次应用退出时任务未完成' } else if (step.status === 'pending') {
            step.status = 'skipped'
          }
        }
      }
    }
    if (recovered) await atomicWrite(this.file(id), JSON.stringify(records))
    this.cache.set(id, records)
    return records
  }
  async list(id: string): Promise<TaskRun[]> { return this.queue.run(async () => structuredClone(await this.load(id))) }
  async put(raw: TaskRun): Promise<void> {
    const run = taskRunSchema.parse(structuredClone(raw))
    await this.queue.run(async () => {
      const current = await this.load(run.taskId)
      const next = [run, ...current.filter((item) => item.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_TASK_RUNS)
      await atomicWrite(this.file(run.taskId), JSON.stringify(next))
      this.cache.set(run.taskId, next)
    })
  }
  async clear(id: string): Promise<void> {
    await this.queue.run(async () => { await rm(this.file(id), { force: true }); this.cache.delete(id) })
  }
}
