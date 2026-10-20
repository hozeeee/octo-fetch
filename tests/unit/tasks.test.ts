import type { Worker } from 'node:worker_threads'
import type { BrowserManager } from '../../src/main/browser/manager'
import type { TaskDraft, TaskRun, TaskRunStep } from '../../src/shared/tasks'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TOOLS } from '../../src/main/mcp/tools'
import { ScriptRunner } from '../../src/main/scripts/runner'
import { ScriptLogStore, ScriptStore } from '../../src/main/scripts/store'
import { ConfigStore } from '../../src/main/storage/store'
import { TaskService } from '../../src/main/tasks/service'
import { TaskLogStore } from '../../src/main/tasks/store'
import { browserOptionsSchema } from '../../src/shared/browser-options'
import { cronMatches, cronNext, validateCron } from '../../src/shared/cron'
import { coerceVariables, variableSchema } from '../../src/shared/scripts'
import { MAX_TASK_RUNS, resolveStepValues, taskRunSchema } from '../../src/shared/tasks'

const directory = () => mkdtemp(path.join(os.tmpdir(), 'octo-tasks-'))
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const taskRun = (taskId: string, index = 0, over: Partial<TaskRun> = {}): TaskRun => taskRunSchema.parse({
  id: randomUUID(), taskId, taskName: '任务', revision: '2026-01-01', trigger: 'manual',
  startedAt: new Date(1000 * index).toISOString(), status: 'success', steps: [], ...over
})

async function fixture() {
  const dir = await directory()
  const config = new ConfigStore(dir); await config.initialize()
  const scriptStore = new ScriptStore(dir)
  const scriptLogs = new ScriptLogStore(dir)
  const taskLogs = new TaskLogStore(dir)
  const workers: (EventEmitter & { terminate: ReturnType<typeof vi.fn> })[] = []
  const manager = {
    scriptSession: vi.fn(async (siteId: string) => ({
      endpoint: 'ws://127.0.0.1/test', targetId: 'target',
      site: { id: siteId, name: '账号', url: 'https://example.com', currentUrl: 'https://example.com/', tabId: randomUUID() }
    }))
  } as unknown as BrowserManager
  const runner = new ScriptRunner(scriptStore, scriptLogs, manager, vi.fn(), () => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0) })
    workers.push(worker)
    return worker as unknown as Worker
  })
  const tasks = new TaskService(config, runner, taskLogs, vi.fn())
  manager.tasks = tasks
  const addSite = async (name: string) => {
    const id = randomUUID()
    const now = new Date().toISOString()
    await config.update((draft) => { draft.sites.push({ id, name, url: 'https://example.com', injections: [], browserOptions: browserOptionsSchema.parse({}), captureEnabled: false, order: draft.sites.length, createdAt: now, updatedAt: now, cookieCount: 0, pendingCookies: false }) })
    return id
  }
  const addScript = (over: Record<string, unknown> = {}) => runner.save(undefined, { kind: 'action', name: '步骤脚本', description: '', match: ['*.example.com'], variables: [], dependencies: [], timeout: 60, source: 'return 1;', ...over }, 'agent')
  // 每步串行执行，需等对应 Worker 就绪且 startAndWait 已登记 waiter（跨越一个宏任务）后再驱动终态。
  const drive = async (index: number, message: unknown) => {
    await vi.waitFor(() => expect(workers.length).toBeGreaterThan(index))
    await flush()
    workers[index].emit('message', message)
  }
  const done = { type: 'done', result: '1', dropped: 0 }
  const failed = { type: 'failed', error: '步骤失败', dropped: 0 }
  return { dir, config, runner, tasks, taskLogs, manager, workers, addSite, addScript, drive, done, failed }
}

describe('自实现 cron 校验、匹配与下次运行', () => {
  it('接受 * , - */n a-b/n，拒绝段数、越界与非法步长', () => {
    for (const expr of ['* * * * *', '*/15 * * * *', '0 9-17 * * 1-5', '0,30 * * * *', '0 0 1-15/2 * *']) expect(validateCron(expr)).toBeUndefined()
    expect(validateCron('* * * *')).toContain('5 段')
    expect(validateCron('60 * * * *')).toBeDefined()
    expect(validateCron('* * * * 8')).toBeDefined()
    expect(validateCron('*/0 * * * *')).toBeDefined()
    expect(validateCron('a * * * *')).toBeDefined()
  })
  it('分时按集合匹配，日与星期遵循 Vixie 或规则', () => {
    const monday = new Date(2026, 0, 5, 10, 30) // 周一
    expect(cronMatches('* * * * *', monday)).toBe(true)
    expect(cronMatches('30 10 5 1 1', monday)).toBe(true)
    expect(cronMatches('0 10 * * *', monday)).toBe(false)
    expect(cronMatches('*/15 * * * *', monday)).toBe(true)
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 5, 10, 31))).toBe(false)
    const thursdayFirst = new Date(2026, 0, 1, 0, 0) // 周四且为 1 号
    expect(cronMatches('0 0 1 * 0', thursdayFirst)).toBe(true) // 日或星期任一命中
    expect(cronMatches('bad expr', monday)).toBe(false)
  })
  it('返回严格晚于起点的下一时刻，非法表达式返回 undefined', () => {
    const from = new Date(2026, 0, 5, 10, 30, 15)
    const quarter = cronNext('*/15 * * * *', from)!
    expect([quarter.getHours(), quarter.getMinutes()]).toEqual([10, 45])
    const midnight = cronNext('0 0 * * *', from)!
    expect([midnight.getDate(), midnight.getHours(), midnight.getMinutes()]).toEqual([6, 0, 0])
    const next = cronNext('30 10 * * *', new Date(2026, 0, 5, 10, 30, 0))!
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([6, 10, 30]) // 同刻不算，顺延到次日
    expect(cronNext('bad', from)).toBeUndefined()
  })
})

describe('步骤变量解析优先级', () => {
  it('links 指向任务变量 > 步骤自定义值 > 脚本默认值', () => {
    const scriptVars = [
      variableSchema.parse({ key: 'a', label: 'A', kind: 'text' }),
      variableSchema.parse({ key: 'b', label: 'B', kind: 'text' }),
      variableSchema.parse({ key: 'c', label: 'C', kind: 'text', default: '默认C' })
    ]
    const taskValues = { shared: '任务A' }
    const step = { links: { a: 'shared', b: 'missing' }, values: { a: '步骤A', b: '步骤B' } }
    // a 走 link，b 的 link 指向不存在的任务变量则回退到步骤值，c 未给出交由默认值
    expect(resolveStepValues(scriptVars, taskValues, step)).toEqual({ a: '任务A', b: '步骤B' })
    expect(coerceVariables(scriptVars, resolveStepValues(scriptVars, taskValues, step))).toEqual({ a: '任务A', b: '步骤B', c: '默认C' })
  })
})

describe('任务执行引擎', () => {
  it('多步串行成功，记录逐步底层运行', async () => {
    const { tasks, addSite, addScript, drive, done } = await fixture()
    const [siteA, siteB] = [await addSite('账号 A'), await addSite('账号 B')]
    const first = await addScript({ name: '第一步' })
    const second = await addScript({ name: '第二步' })
    const draft: TaskDraft = { name: '双步任务', steps: [{ scriptId: first.id, siteId: siteA }, { scriptId: second.id, siteId: siteB }] } as TaskDraft
    const saved = await tasks.save(undefined, draft, 'manual')
    await tasks.run(saved.id, 'manual')
    await drive(0, done); await drive(1, done)
    await vi.waitFor(() => expect(tasks.active()).toHaveLength(0))
    const run = (await tasks.runsOf(saved.id))[0]
    expect(run.status).toBe('success')
    expect(run.steps.map((step) => step.status)).toEqual(['success', 'success'])
    expect(run.steps.every((step) => step.scriptRunId)).toBe(true)
  })
  it('onError=\'stop\' 遇非可选步骤失败即中止，其余标记跳过', async () => {
    const { tasks, addSite, addScript, drive, done, failed } = await fixture()
    const site = await addSite('账号')
    const script = await addScript()
    const steps = [{ scriptId: script.id, siteId: site }, { scriptId: script.id, siteId: site }, { scriptId: script.id, siteId: site }]
    const saved = await tasks.save(undefined, { name: '停止任务', onError: 'stop', steps } as TaskDraft, 'manual')
    await tasks.run(saved.id, 'manual')
    await drive(0, done); await drive(1, failed)
    await vi.waitFor(() => expect(tasks.active()).toHaveLength(0))
    const run = (await tasks.runsOf(saved.id))[0]
    expect(run.status).toBe('error')
    expect(run.steps.map((step) => step.status)).toEqual(['success', 'error', 'skipped'])
  })
  it('onError=\'continue\' + optional 失败继续，任务判为部分成功', async () => {
    const { tasks, addSite, addScript, drive, done, failed } = await fixture()
    const site = await addSite('账号')
    const script = await addScript()
    const steps = [{ scriptId: script.id, siteId: site, optional: true }, { scriptId: script.id, siteId: site }]
    const saved = await tasks.save(undefined, { name: '继续任务', onError: 'continue', steps } as TaskDraft, 'manual')
    await tasks.run(saved.id, 'manual')
    await drive(0, failed); await drive(1, done)
    await vi.waitFor(() => expect(tasks.active()).toHaveLength(0))
    const run = (await tasks.runsOf(saved.id))[0]
    expect(run.status).toBe('partial')
    expect(run.steps.map((step) => step.status)).toEqual(['error', 'success'])
  })
})

describe('TaskLogStore 轮转与中断恢复', () => {
  it('保留最近 20 次，重启后运行中记录变为异常中断', async () => {
    const dir = await directory()
    const logs = new TaskLogStore(dir)
    const id = randomUUID()
    for (let i = 0; i < MAX_TASK_RUNS + 3; i++) await logs.put(taskRun(id, i))
    const recent = await logs.list(id)
    expect(recent).toHaveLength(MAX_TASK_RUNS)
    expect(recent[0].startedAt).toBe(new Date((MAX_TASK_RUNS + 2) * 1000).toISOString())
    const steps: TaskRunStep[] = [
      { index: 0, scriptId: randomUUID(), scriptName: '一', siteId: randomUUID(), siteName: '甲', status: 'running' },
      { index: 1, scriptId: randomUUID(), scriptName: '二', siteId: randomUUID(), siteName: '乙', status: 'pending' }
    ]
    await logs.put(taskRun(id, 100, { status: 'running', steps }))
    const recovered = new TaskLogStore(dir)
    const restored = (await recovered.list(id))[0]
    expect(restored).toMatchObject({ status: 'interrupted' })
    expect(restored.steps.map((step) => step.status)).toEqual(['cancelled', 'skipped'])
    await recovered.clear(id)
    expect(await recovered.list(id)).toEqual([])
  })
})

describe('MCP 任务工具链路', () => {
  it('save_task -> list_tasks -> run_task -> read_task_runs -> delete_task', async () => {
    const { tasks, manager, runner, addSite, addScript, drive, done } = await fixture()
    const site = await addSite('账号')
    const script = await addScript()
    const call = async (name: string, args: unknown = {}) => {
      const content = await TOOLS.find((tool) => tool.name === name)!.run(manager, args, runner)
      return content.map((item) => item.type === 'text' ? item.text : '').join('')
    }
    const { task_id } = JSON.parse(await call('save_task', { draft: { name: 'MCP 任务', steps: [{ scriptId: script.id, siteId: site }] } }))
    expect(tasks.get(task_id).origin).toBe('agent')
    expect(await call('list_tasks')).toContain(task_id)
    expect(await call('read_task', { task_id })).toContain('valueKeys')
    const { run_id } = JSON.parse(await call('run_task', { task_id }))
    await drive(0, done)
    await vi.waitFor(() => expect(tasks.active()).toHaveLength(0))
    expect(JSON.parse(await call('read_task_runs', { task_id, run_id }))[0]).toMatchObject({ id: run_id, status: 'success' })
    await expect(call('save_task', { draft: { name: '缺步骤' } })).rejects.toThrow()
    await call('delete_task', { task_id })
    expect(tasks.list()).toEqual([])
  })
})
