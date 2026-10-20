import type { ScriptValues, ScriptVariable } from './scripts'
import { z } from 'zod'
import { validateCron } from './cron'
import { keySchema, valuesSchema, variableSchema } from './scripts'

export const MAX_TASKS = 50
export const MAX_TASK_STEPS = 50
export const MAX_TASK_RUNS = 20

// 每个步骤固定绑定一个行动脚本与目标网站；values 为步骤自定义字面值，links 把脚本变量指向任务变量。
export const taskStepSchema = z.object({
  scriptId: z.uuid(), siteId: z.uuid(),
  values: valuesSchema.default({}), links: z.record(keySchema, keySchema).default({}), optional: z.boolean().default(false)
}).strict()
export type TaskStep = z.infer<typeof taskStepSchema>

export const taskScheduleSchema = z.object({
  enabled: z.boolean().default(false), cron: z.string().trim().max(120).default('')
}).strict().superRefine((schedule, ctx) => {
  if (!schedule.enabled) return
  const error = validateCron(schedule.cron)
  if (error) ctx.addIssue({ code: 'custom', message: error, path: ['cron'] })
})
export type TaskSchedule = z.infer<typeof taskScheduleSchema>

export const taskDraftSchema = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().max(2000).default(''),
  variables: z.array(variableSchema).max(30).default([]), values: valuesSchema.default({}),
  steps: z.array(taskStepSchema).min(1).max(MAX_TASK_STEPS),
  onError: z.enum(['stop', 'continue']).default('stop'),
  schedule: taskScheduleSchema.default({ enabled: false, cron: '' })
}).strict().superRefine((draft, ctx) => {
  const declared = new Set(draft.variables.map((item) => item.key))
  if (declared.size !== draft.variables.length) ctx.addIssue({ code: 'custom', message: '任务变量名不能重复', path: ['variables'] })
  for (const key of Object.keys(draft.values)) {
    if (!declared.has(key)) ctx.addIssue({ code: 'custom', message: `未声明的任务变量：${key}`, path: ['values'] })
  }
  draft.steps.forEach((step, index) => {
    for (const [scriptKey, taskKey] of Object.entries(step.links)) {
      if (!declared.has(taskKey)) ctx.addIssue({ code: 'custom', message: `步骤 ${index + 1} 引用了未声明的任务变量：${taskKey}`, path: ['steps', index, 'links', scriptKey] })
    }
  })
})
export type TaskDraft = z.infer<typeof taskDraftSchema>

export const taskRunStepSchema = z.object({
  index: z.number().int().nonnegative(), scriptId: z.uuid(), scriptName: z.string(), siteId: z.uuid(), siteName: z.string(),
  status: z.enum(['pending', 'running', 'success', 'error', 'skipped', 'cancelled']),
  scriptRunId: z.uuid().optional(), startedAt: z.string().optional(), endedAt: z.string().optional(), error: z.string().max(4000).optional()
}).strict()
export type TaskRunStep = z.infer<typeof taskRunStepSchema>

export const taskRunSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), taskName: z.string(), revision: z.string(), trigger: z.enum(['manual', 'schedule']),
  startedAt: z.string(), endedAt: z.string().optional(),
  status: z.enum(['running', 'success', 'partial', 'error', 'cancelled', 'interrupted']),
  steps: z.array(taskRunStepSchema).max(MAX_TASK_STEPS)
}).strict()
export type TaskRun = z.infer<typeof taskRunSchema>

export const taskSchema = z.object({
  id: z.uuid(), draft: taskDraftSchema, origin: z.enum(['manual', 'agent']),
  createdAt: z.string(), updatedAt: z.string(), lastRunAt: z.string().optional(), lastStatus: taskRunSchema.shape.status.optional()
}).strict()
export type SavedTask = z.infer<typeof taskSchema>
export type ActiveTaskRun = Pick<TaskRun, 'id' | 'taskId' | 'startedAt'>
export const TASK_STATUS_LABELS: Record<TaskRun['status'], string> = { running: '运行中', success: '成功', partial: '部分成功', error: '失败', cancelled: '已取消', interrupted: '异常中断' }
export const TASK_STEP_LABELS: Record<TaskRunStep['status'], string> = { pending: '待执行', running: '运行中', success: '成功', error: '失败', skipped: '已跳过', cancelled: '已取消' }

// 组装某步骤脚本的入参：links 指向的任务变量值 > 步骤自定义值；未给出的键交由 coerceVariables 套用脚本默认值。
export function resolveStepValues(scriptVars: ScriptVariable[], taskValues: ScriptValues, step: { values: ScriptValues; links: Record<string, string> }): ScriptValues {
  const assembled: ScriptValues = {}
  for (const variable of scriptVars) {
    const linked = step.links[variable.key]
    if (linked !== undefined && Object.hasOwn(taskValues, linked)) { assembled[variable.key] = taskValues[linked]; continue }
    if (Object.hasOwn(step.values, variable.key)) assembled[variable.key] = step.values[variable.key]
  }
  return assembled
}

export const TASK_CONTRACT = `任务编排（task）：把多个行动脚本按顺序组织成可复用、可定时的任务。
每个步骤固定绑定一个行动脚本（kind=action）与目标网站；步骤串行执行，每步真正跑一次行动运行（含单站点单行动锁、域名校验、变量校验与完整日志）。注入脚本不参与编排。
变量：任务声明 variables 并存 values；步骤对脚本每个变量可二选一——links[脚本变量]=任务变量（引用任务变量），或 values[脚本变量]=自定义值。取值优先级：links 指向的任务变量 > 步骤自定义值 > 脚本默认值。
出错：onError=stop 时首个非可选步骤失败即中止，其余标记 skipped，任务 error；onError=continue 时继续执行，存在失败则任务 partial。步骤 optional=true 允许失败不影响任务成败。
定时：schedule.enabled + 5 段 cron（分 时 日 月 周，本机时区、分钟粒度）；也可手动 run_task 触发。应用关闭期间错过的计划不补跑。
流程：save_task 保存或更新；run_task 触发后用 read_task_runs 轮询逐步状态，不能把已受理当成成功。运行中的任务不能编辑或删除。保存、运行、取消、删除均需三级身份。`
