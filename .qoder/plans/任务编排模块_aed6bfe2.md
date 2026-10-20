# 任务编排（Task Orchestration）模块

## 命名
模块对外名称定为"任务编排"（导航项显示"任务编排"），内部标识统一用 `task`。一个"任务"= 有序的脚本步骤 + 任务级变量 + 定时计划。

## 核心设计决策
- 每个步骤固定绑定 `scriptId`（仅 `kind==='action'` 行动脚本）+ `siteId`（目标网站）。注入脚本是站点级常驻能力，不参与步骤编排。
- 步骤按顺序串行执行；每步复用现有 `ScriptRunner` 真正跑一次行动运行（自动获得单站点单行动锁、域名校验、变量校验、完整日志）。
- 定时用自实现的 5 段 cron（不引入依赖，契合项目零第三方风格），基于本机时区，分钟粒度。
- 出错处理：任务级 `onError: 'stop' | 'continue'`；步骤级 `optional`（允许失败）。终态含 `partial`（部分失败但继续）。
- 任务存放在 `config.json` 的 `config.tasks`（与 sites/mcp 同级），复用 `ConfigStore` 的原子写入、备份、快照分发；无源码，体积小，可直接进快照。任务运行记录单独存 `task-logs/`（仿 `ScriptLogStore`）。

## 变量继承机制
- 任务声明 `variables`（复用 `variableSchema`）并存配置值 `values`。
- 每个步骤对其脚本的每个变量，可二选一：`links[脚本变量key] = 任务变量key`（引用任务变量），或 `values[脚本变量key]`（自定义字面值）。
- 运行时按脚本变量逐个解析优先级：`links 指向的任务变量值` > `步骤自定义值` > `脚本默认值`，最终交给现有 `coerceVariables(script.draft.variables, assembled)` 校验。任务变量值来自 `coerceVariables(task.draft.variables, task.draft.values)`。

## 新增文件

### src/shared/cron.ts
自实现 5 段 cron（分 时 日 月 周），支持 `*` `,` `-` `*/n` `a-b/n`：
- `validateCron(expr): string|undefined`（返回错误信息或空）
- `cronMatches(expr, date): boolean`
- `cronNext(expr, from): Date|undefined`（供调度与界面"下次运行"展示）

### src/shared/tasks.ts
从 `scripts.ts` 导出并复用 `keySchema`、`variableSchema`、`valuesSchema`、`coerceVariables`（`scripts.ts` 需 export `keySchema`）。定义：
- `MAX_TASKS = 50`、`MAX_TASK_STEPS = 50`、`MAX_TASK_RUNS = 20`
- `taskStepSchema = z.object({ scriptId: uuid, siteId: uuid, values: valuesSchema.default({}), links: z.record(keySchema, keySchema).default({}), optional: z.boolean().default(false) }).strict()`
- `taskScheduleSchema = z.object({ enabled: boolean.default(false), cron: string.trim().max(120).default('') }).strict()`，`superRefine` 在 enabled 时用 `validateCron` 校验
- `taskDraftSchema = z.object({ name, description, variables: array(variableSchema).max(30).default([]), values: valuesSchema.default({}), steps: array(taskStepSchema).min(1).max(50), onError: enum(['stop','continue']).default('stop'), schedule: taskScheduleSchema.default(...) }).strict()`，`superRefine` 校验任务变量 key 唯一、`values`/`links` 与声明一致
- `taskSchema = { id, draft, origin: enum(['manual','agent']), createdAt, updatedAt, lastRunAt?: string, lastStatus?: TaskRun['status'] }`
- `taskRunSchema`：`{ id, taskId, taskName, revision, trigger: 'manual'|'schedule', startedAt, endedAt?, status: 'running'|'success'|'partial'|'error'|'cancelled'|'interrupted', steps: [{ index, scriptId, scriptName, siteId, siteName, status, scriptRunId?, startedAt?, endedAt?, error? }] }`，`.max(MAX_TASK_RUNS)`
- `ActiveTaskRun = Pick<TaskRun,'id'|'taskId'|'startedAt'>`、`TASK_STATUS_LABELS`
- `resolveStepValues(scriptVars, taskValues, step): ScriptValues`（组装后返回，交由调用方 coerce）
- `TASK_CONTRACT`（MCP 用简要契约文本）

### src/main/tasks/store.ts
`TaskLogStore`（完全仿 `ScriptLogStore`：`task-logs/{taskId}.json`，保留最近 `MAX_TASK_RUNS`，加载时把 `running` 恢复为 `interrupted`，`list/put/clear`，`SerialQueue`+`atomicWrite`）。任务本体的增删改直接走 `ConfigStore.update`（仿 `manager.saveSite`），不单独建 TaskStore 类。

### src/main/tasks/service.ts
`TaskService`，构造入参 `(config: ConfigStore, scripts: ScriptRunner, manager: BrowserManager, logs: TaskLogStore, changed)`：
- `list()/get()`：读 `config.tasks`
- `save(id, draft, origin)`：校验步骤引用的脚本存在且为 action、网站存在、`coerceVariables` 校验任务值与每步组装值；运行中禁止编辑；`config.update` 写入，维护 createdAt/updatedAt
- `remove(id)`：运行中禁止删除；`config.update` 移除 + `logs.clear`
- `runs(id)` / `clearLogs(id)`：合并内存运行态与 `logs`
- `active(): ActiveTaskRun[]`
- `run(taskId, trigger)`：串行执行各步骤。每步 `resolveStepValues` -> `coerceVariables` -> `await scripts.startAndWait({scriptId,siteId,values})`（见下）；记录 `scriptRunId` 与步骤状态。失败且非 optional 且 `onError==='stop'` 则中止剩余步骤（标记 skipped），任务 `error`；有失败但继续则 `partial`；全成功 `success`。全程 `logs.put` 落盘、`changed()`
- `cancel(taskId)`：取消当前步骤对应的 script run 并将任务标记 cancelled
- 调度：`start()` 启一个 ~20s 的 `setInterval`；对每个 `schedule.enabled` 且 cron 合法的任务，用 `cronNext(cron, base)`（`base = max(lastRunAt, serviceStartTime)`，避免应用重启后补跑历史）判断是否到点且未在运行 -> 触发 `run(...,'schedule')`，成功后写 `lastRunAt`
- `shutdown()`：清定时器，取消运行中的任务

### src/main/mcp/tasks.ts
`TASK_TOOLS`（仿 `SCRIPT_TOOLS`，经 `manager.tasks` 访问）：`list_tasks`(read)、`read_task`(read)、`read_task_runs`(read)、`save_task`(full)、`run_task`(full)、`cancel_task_run`(full)、`delete_task`(full)。

### 渲染层 src/renderer/src/features/tasks/
- `Tasks.tsx`：列表（名称、步骤数、定时 cron + 下次运行、上次状态、运行中标记），操作：运行 / 编辑 / 日志 / 删除 / 定时开关
- `TaskEditor.tsx`：Modal 表单——名称、说明；任务变量（复用 ScriptEditor 里的变量 Form.List 结构）；任务变量取值；步骤 Form.List（选行动脚本、选网站、每个脚本变量给"引用任务变量 / 自定义值"来源选择、optional 开关、上移下移删除）；`onError` 单选；定时（启用开关 + cron 输入 + 用 `cronNext` 预览下次几次运行）。提交前 `taskDraftSchema.safeParse`
- `TaskRuns.tsx`：仿 `ScriptLogs`，展示最近任务运行、逐步状态与错误，步骤可跳看其底层脚本运行日志（`window.octo.scriptRuns(scriptId)`）

## 修改文件

### src/shared/scripts.ts
`export` 现有 `keySchema`（供 tasks.ts 复用）。

### src/main/scripts/runner.ts
新增 `startAndWait(request): Promise<ScriptRun>`：内部 `await this.start(request)` 拿到 run.id，登记 `waiters: Map<runId, resolve>`；在 `finish()` 落盘后解析对应 waiter 并回传终态 run。`start()` 同步抛错时 `startAndWait` 直接 reject（由 TaskService 记为步骤错误）。

### src/shared/model.ts
- `configSchema` 增 `tasks: z.array(taskSchema).max(MAX_TASKS).default([])`（旧配置无该字段仍可解析）
- `commandSchema` 增：`task.save`(id?, draft)、`task.run`(id)、`task.cancel`(id)、`task.enable`(id, enabled)、`{type: enum(['task.delete','task.logs.clear']), id}`
- `Snapshot` 增 `taskRuns: ActiveTaskRun[]`（tasks 本体随 `config.tasks` 下发）
- `DesktopAPI` 增 `taskRuns(id): Promise<Reply<TaskRun[]>>`

### src/main/ipc/register.ts
新增 `octo:task-runs` handler；`octo:command` 里处理 `task.*`（`task.delete` 走确认对话框，仿 `script.delete`）；`registerIPC` 参数接入 `tasks: TaskService`。

### src/preload/index.ts
增 `taskRuns: (id) => ipcRenderer.invoke('octo:task-runs', id)`。

### src/main/mcp/tools.ts
`TOOLS` 展开引入 `...TASK_TOOLS`。

### src/main/index.ts
- 构造 `taskLogs = new TaskLogStore(...)`、`manager.tasks = new TaskService(store, scripts, manager, taskLogs, changed)`（在 `scripts` 之后）
- `snapshot()` 增 `taskRuns: manager.tasks!.active()`，warnings 合并 task 持久化错误
- `registerIPC(...)` 传入 `manager.tasks`
- 窗口就绪后 `manager.tasks.start()` 启动调度；`requestQuit`/失败分支里 `await manager.tasks?.shutdown()`

### src/renderer/src/store.ts
`View` 联合类型增 `'tasks'`。

### src/renderer/src/main.tsx
导航 items 增 `{ id:'tasks', label:'任务编排', icon:<...> }`（用现有已导入或新增一个 antd icon），显示任务计数；路由渲染 `<Tasks />`。

### src/renderer/src/styles.css
按需补充少量步骤/任务列表样式，尽量复用现有 `script-*` 类。

## 测试

### tests/unit/tasks.test.ts（Vitest）
- cron：`validateCron`/`cronMatches`/`cronNext` 覆盖 `*` `,` `-` `*/n` `a-b/n` 与非法表达式
- 变量解析：links > 步骤自定义 > 脚本默认 的优先级，未声明/类型错误被拒
- 执行引擎：多步串行成功；`onError='stop'` 遇错中止且剩余标记 skipped；`onError='continue'` + optional 得到 `partial`；用仿 `scripts.test.ts` 的 fixture（EventEmitter 假 Worker）驱动底层运行
- `TaskLogStore` 轮转与 `interrupted` 恢复
- MCP：save_task -> list_tasks -> run_task -> read_task_runs -> delete_task 链路

### tests/e2e/tasks.spec.ts（Playwright，仿 scripts.spec.ts）
- 建 2 个网站并启动，建 1 个带任务变量的任务、2 个步骤（分别绑不同网站、一个步骤引用任务变量），手动运行，断言两步底层脚本运行成功、任务运行 `success`，界面日志可见；覆盖定时开关的保存与展示。

## 假设与边界
- 步骤执行依赖目标网站已启动且有匹配域名的标签；未满足时该步骤按 `ScriptRunner.start` 抛出的错误记为失败，遵循 `onError`。
- cron 使用本机时区、分钟粒度；应用关闭期间错过的计划不补跑。
- 任务不引入新 Worker，复用 `script-worker.js`，无需改 `electron.vite.config.ts`。
- MCP 任务工具均为 full 级（保存/运行/删除），与脚本工具权限一致。