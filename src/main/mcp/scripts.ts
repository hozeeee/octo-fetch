import type { McpLevel } from '../../shared/model'
import type { ScriptRunner } from '../scripts/runner'
import type { Content, Tool } from './tools'
import { z } from 'zod'
import { NOTIFICATION_TEMPLATE, notificationQuerySchema } from '../../shared/notifications'
import { INJECTION_TEMPLATE, matchesUrl, REQUEST_TEMPLATE, SANDBOX_SERVICE_TEMPLATE, SANDBOX_SERVICE_VARIABLES, SANDBOX_TEMPLATE, SCRIPT_CONTRACT, SCRIPT_TEMPLATE, scriptDraftSchema, scriptKindSchema, valuesSchema } from '../../shared/scripts'

function scriptTool<T extends z.ZodType>(name: string, level: McpLevel, description: string, schema: T,
  run: (scripts: ScriptRunner, args: z.output<T>) => Promise<unknown> | unknown): Tool {
  return {
    name, level, description, input: z.toJSONSchema(schema, { io: 'input' }),
    async run(_manager, raw, scripts): Promise<Content[]> {
      if (!scripts) throw new Error('脚本服务尚未就绪')
      const value = await run(scripts, schema.parse(raw ?? {}))
      return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    }
  }
}
const id = z.object({ script_id: z.uuid().describe('脚本 ID，来自 list_scripts 或 save_script') }).strict()
export const SCRIPT_TOOLS: Tool[] = [
  scriptTool('list_notification_channels', 'read', '列出可供 octo.notify 使用的通知通道摘要，不含配置、地址、密钥或收件人。', z.object({}).strict(), (scripts) => scripts.notifications?.list() || []),
  scriptTool('read_notification_logs', 'read', '按 runId 查询关联通知的最终结果；服务端已受理不代表已阅读。日志不含正文或凭据。', notificationQuerySchema.extend({ runId: z.uuid() }), (scripts, query) => scripts.notifications?.logs.list(query) || { items: [], total: 0 }),
  scriptTool('script_guide', 'read', '生成可重复使用的 .js 能力前先读本契约：注入 API、参数、域名适配、持久化和执行边界。', z.object({}).strict(), () => ({ guide: SCRIPT_CONTRACT, nodeVersion: process.versions.node, template: SCRIPT_TEMPLATE, templates: { action: SCRIPT_TEMPLATE, injection: INJECTION_TEMPLATE, request: REQUEST_TEMPLATE, notification: NOTIFICATION_TEMPLATE, sandbox: SANDBOX_TEMPLATE, sandbox_service: SANDBOX_SERVICE_TEMPLATE }, sandbox_service_variables: SANDBOX_SERVICE_VARIABLES })),
  scriptTool('list_scripts', 'read', '重复任务先查已有脚本，优先复用；可按当前网址筛选适用能力。返回元数据及运行中任务，不含源码。',
    z.object({ url: z.string().url().optional(), kind: scriptKindSchema.optional() }).strict(), (scripts, args) => ({
      scripts: scripts.store.list().filter((script) => (!args.kind || script.draft.kind === args.kind) && (!args.url || script.draft.kind === 'sandbox' || matchesUrl(script.draft.match, args.url))), active: scripts.active()
    })),
  scriptTool('read_script', 'read', '读取源码与参数声明，用于理解或改进已有能力。参数值不随源码返回。', id, (scripts, args) => {
    const { values: _values, ...script } = scripts.store.get(args.script_id)
    return script
  }),
  scriptTool('read_script_runs', 'read', '按脚本读取最近 20 次日志、状态、结果及版本；一次性运行轮询至结束，常驻沙箱轮询至 phase=active 或失败，最新输出不是最终成功结果。',
    id.extend({ run_id: z.uuid().optional() }).strict(), async (scripts, args) => (await scripts.runs(args.script_id)).filter((run) => !args.run_id || run.id === args.run_id)),
  scriptTool('save_script', 'full', '把任务固化为客户端可见、可编辑、可迁移的 .js 脚本。先读 script_guide；先查 list_scripts 避免重复。省略 script_id 新建，否则更新，不自动执行。',
    id.partial().extend({ draft: scriptDraftSchema }).strict(), async (scripts, args) => {
      const script = await scripts.save(args.script_id, args.draft, 'agent')
      const install = script.draft.dependencies.length ? '获得用户安装授权后先调用 install_dependencies。' : ''
      const next = script.draft.kind === 'injection' ? `${install}通过 save_site.injections 绑定网站，获得授权后重启网站生效。` : `${install}获得用户执行授权后调用 run_script；用 read_script_runs 检查结果。`
      return { script_id: script.id, name: script.draft.name, kind: script.draft.kind, next }
    }),
  scriptTool('install_dependencies', 'full', '安装已保存脚本声明的第三方 npm 包。必须先获得用户授权；三类脚本均支持，使用全局 npm Registry，禁用 lifecycle scripts，返回有界安装日志。脚本运行中或依赖安装中不能调用。',
    id, async (scripts, args) => scripts.installDependencies(args.script_id)),
  scriptTool('run_script', 'full', '运行已保存的行动或沙箱，仅在用户授权后调用。行动必须指定已启动网站且标签匹配域名；沙箱禁止传 site_id/tab_id。三类脚本均开放本机 Node.js 能力，不是安全隔离；注入需绑定网站。声明依赖后须先调用 install_dependencies，未安装成功、声明已变更或依赖文件缺失都会拒绝启动。立即返回 run_id，轮询 read_script_runs；常驻 phase=active 才表示就绪。',
    id.extend({ site_id: z.uuid().optional(), tab_id: z.uuid().optional(), values: valuesSchema.default({}) }).strict(), async (scripts, args) => {
      const run = await scripts.start({ scriptId: args.script_id, siteId: args.site_id, tabId: args.tab_id, values: args.values })
      return { run_id: run.id, script_id: run.scriptId, status: 'running', next: 'read_script_runs' }
    }),
  scriptTool('cancel_script_run', 'full', '停止行动或沙箱；沙箱先有界清理再终止进程。网页、文件、网络和外部进程等已发生的副作用无法回滚。',
    z.object({ run_id: z.uuid() }).strict(), async (scripts, args) => { await scripts.cancel(args.run_id); return '已取消' }),
  scriptTool('delete_script', 'full', '删除脚本与运行记录，不影响网站登录态。不可恢复，必须先获得用户删除授权。运行中不能删除。',
    id, async (scripts, args) => { await scripts.remove(args.script_id); return '已删除脚本及运行记录' })
]
