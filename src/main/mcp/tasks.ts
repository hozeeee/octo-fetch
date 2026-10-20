import type { McpLevel } from '../../shared/model'
import type { SavedTask } from '../../shared/tasks'
import type { TaskService } from '../tasks/service'
import type { Content, Tool } from './tools'
import { z } from 'zod'
import { TASK_CONTRACT, taskDraftSchema } from '../../shared/tasks'

function taskTool<T extends z.ZodType>(name: string, level: McpLevel, description: string, schema: T,
  run: (tasks: TaskService, args: z.output<T>) => Promise<unknown> | unknown): Tool {
  return {
    name, level, description, input: z.toJSONSchema(schema, { io: 'input' }),
    async run(manager, raw): Promise<Content[]> {
      if (!manager.tasks) throw new Error('任务服务尚未就绪')
      const value = await run(manager.tasks, schema.parse(raw ?? {}))
      return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    }
  }
}
// 读取任务时只暴露结构（变量声明、步骤引用、定时），不回传具体参数值，与 read_script 的隐私一致。
function readTask(task: SavedTask) {
  const { values, steps, ...draft } = task.draft
  return {
    id: task.id, origin: task.origin, createdAt: task.createdAt, updatedAt: task.updatedAt,
    lastRunAt: task.lastRunAt, lastStatus: task.lastStatus,
    draft: {
      ...draft, valueKeys: Object.keys(values),
      steps: steps.map((step) => ({ scriptId: step.scriptId, siteId: step.siteId, links: step.links, optional: step.optional, valueKeys: Object.keys(step.values) }))
    }
  }
}
const id = z.object({ task_id: z.uuid().describe('任务 ID，来自 list_tasks 或 save_task') }).strict()
export const TASK_TOOLS: Tool[] = [
  taskTool('list_tasks', 'read', '组织多脚本的复用/定时流程前先查已有任务；返回名称、步骤数、定时与上次状态，含运行中任务。', z.object({}).strict(),
    (tasks) => ({
      guide: TASK_CONTRACT,
      tasks: tasks.list().map((task) => ({
        task_id: task.id, name: task.draft.name, steps: task.draft.steps.length, on_error: task.draft.onError,
        schedule: task.draft.schedule, last_run_at: task.lastRunAt, last_status: task.lastStatus, running: tasks.active().some((run) => run.taskId === task.id)
      })), active: tasks.active()
    })),
  taskTool('read_task', 'read', '读取任务的变量声明、步骤引用（脚本、网站、变量来源）与定时配置；不回传具体参数值。', id, (tasks, args) => readTask(tasks.get(args.task_id))),
  taskTool('read_task_runs', 'read', '按任务读取最近 20 次运行记录、逐步状态、底层脚本运行 ID 与错误；run_task 后轮询此工具直到对应 run_id 结束。',
    id.extend({ run_id: z.uuid().optional() }).strict(), async (tasks, args) => (await tasks.runsOf(args.task_id)).filter((run) => !args.run_id || run.id === args.run_id)),
  taskTool('save_task', 'full', '把多个行动脚本按顺序固化成可复用、可定时的任务。先读 list_tasks 的 guide；步骤须绑定已保存的行动脚本与网站。省略 task_id 新建，否则更新，不自动执行。',
    id.partial().extend({ draft: taskDraftSchema }).strict(), async (tasks, args) => {
      const task = await tasks.save(args.task_id, args.draft, 'agent')
      return { task_id: task.id, name: task.draft.name, steps: task.draft.steps.length, next: '已保存到客户端「任务编排」。获得用户授权后 run_task；用 read_task_runs 检查结果。' }
    }),
  taskTool('run_task', 'full', '手动触发已保存的任务，串行执行各步骤。仅在用户授权执行后调用；相关网站须已启动且当前标签匹配域名。立即返回 run_id；用 read_task_runs 轮询，不能把已受理当成成功。',
    id, async (tasks, args) => {
      const run = await tasks.run(args.task_id, 'manual')
      return { run_id: run.id, task_id: run.taskId, status: 'running', next: 'read_task_runs' }
    }),
  taskTool('cancel_task_run', 'full', '取消任务当前运行；正在执行的步骤会一并终止，已发起的网页操作可能完成，无法回滚。',
    id, async (tasks, args) => { await tasks.cancel(args.task_id); return '已请求取消该任务运行' }),
  taskTool('delete_task', 'full', '删除任务及其运行记录，不影响脚本与网站。不可恢复，必须先获得用户删除授权。运行中不能删除。',
    id, async (tasks, args) => { await tasks.remove(args.task_id); return '已删除任务及运行记录' })
]
