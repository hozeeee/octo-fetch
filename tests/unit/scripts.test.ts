import type { Worker } from 'node:worker_threads'
import type { BrowserManager } from '../../src/main/browser/manager'
import type { WorkerInput } from '../../src/main/scripts/runner'
import type { ScriptDraft, ScriptRun } from '../../src/shared/scripts'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { constants, Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { TOOLS } from '../../src/main/mcp/tools'
import { createScriptModuleLoader } from '../../src/main/scripts/module-loader'
import { markDependenciesInstalled } from '../../src/main/scripts/packages'
import { ScriptRunner } from '../../src/main/scripts/runner'
import { ScriptLogStore, ScriptStore } from '../../src/main/scripts/store'
import { coerceVariables, domainSchema, exportScript, importScript, matchesUrl, MAX_LOGS, MAX_RUNS, MAX_SCRIPT_FILE_BYTES, scriptDraftSchema, variableSchema } from '../../src/shared/scripts'

const draft: ScriptDraft = { kind: 'action', name: '搜索能力', description: '可重复执行', match: ['*.example.com'], variables: [], dependencies: [], timeout: 60, source: 'console.log(\'执行\'); return { ok: true };' }
const directory = () => mkdtemp(path.join(os.tmpdir(), 'octo-scripts-'))
const record = (scriptId: string, index = 0): ScriptRun => ({ kind: 'action', id: randomUUID(), scriptId, scriptName: '测试', revision: '2026-01-01', siteId: randomUUID(), siteName: '账号 A', tabId: randomUUID(), url: 'https://example.com', startedAt: new Date(1000 * index).toISOString(), status: 'success', logs: [], droppedLogs: 0 })

async function fixture() {
  const dir = await directory()
  const store = new ScriptStore(dir)
  const logs = new ScriptLogStore(dir)
  const siteId = randomUUID()
  const session = { endpoint: 'ws://127.0.0.1/test', targetId: 'target', site: { id: siteId, name: '账号', url: 'https://example.com', currentUrl: 'https://www.example.com/search', tabId: randomUUID() } }
  const manager = { scriptSession: vi.fn().mockResolvedValue(session) } as unknown as BrowserManager
  const workers: (EventEmitter & { terminate: ReturnType<typeof vi.fn> })[] = []
  const inputs: WorkerInput[] = []
  const runner = new ScriptRunner(store, logs, manager, vi.fn(), (input) => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0) })
    inputs.push(input); workers.push(worker)
    return worker as unknown as Worker
  })
  return { dir, store, logs, manager, siteId, session, runner, workers, inputs }
}

describe('脚本契约与可迁移性', () => {
  it('匹配根域和子域，不接受相似后缀、凭据或非网页协议', () => {
    for (const url of ['https://example.com/a', 'https://a.b.example.com', 'http://EXAMPLE.COM:8080']) expect(matchesUrl(['*.example.com'], url)).toBe(true)
    for (const url of ['https://badexample.com', 'https://example.com.evil.test', 'file:///example.com', 'https://x:y@example.com']) expect(matchesUrl(['*.example.com'], url)).toBe(false)
    expect(matchesUrl(['example.com'], 'https://a.example.com')).toBe(false)
    expect(matchesUrl(['127.0.0.1'], 'http://127.0.0.1:3333')).toBe(true)
    for (const pattern of ['*', 'https://example.com', 'example.com/path', 'example.com:80', 'foo.*.com']) expect(domainSchema.safeParse(pattern).success).toBe(false)
  })
  it('按脚本目录隔离 CommonJS 与动态 import 的模块解析', async () => {
    const dir = await directory()
    const roots = [path.join(dir, 'first'), path.join(dir, 'second')]
    for (const [index, root] of roots.entries()) {
      const module = path.join(root, 'node_modules', 'same-package')
      await mkdir(module, { recursive: true })
      await writeFile(path.join(module, 'package.json'), JSON.stringify({ name: 'same-package', version: '1.0.0', main: 'index.js' }))
      await writeFile(path.join(module, 'index.js'), `module.exports = { value: ${index + 1} }`)
    }
    const first = createScriptModuleLoader(roots[0])
    const second = createScriptModuleLoader(roots[1])
    expect(first.require('same-package')).toEqual({ value: 1 })
    expect(second.require('same-package')).toEqual({ value: 2 })
    const dynamic = (filename: string) => new Script(`import('same-package').then((pkg) => pkg.default.value)`, { filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
    await expect(dynamic(first.filename).runInNewContext()).resolves.toBe(1)
    await expect(dynamic(second.filename).runInNewContext()).resolves.toBe(2)
  })
  it('变量处理必填、缺省、数字范围、枚举与 false，不接受多余变量', () => {
    const variables = [
      variableSchema.parse({ key: 'query', label: '搜索内容', kind: 'text', required: true }),
      variableSchema.parse({ key: 'pages', label: '搜索页码', kind: 'number', min: 1, max: 10, default: 2 }),
      variableSchema.parse({ key: 'format', label: '输出格式', kind: 'enum', options: ['json', 'csv'], default: 'json' }),
      variableSchema.parse({ key: 'enabled', label: '开启', kind: 'boolean', default: true })
    ]
    expect(coerceVariables(variables, { query: '茶叶', pages: '3', enabled: 'false' })).toEqual({ query: '茶叶', pages: 3, format: 'json', enabled: false })
    expect(() => coerceVariables(variables, {})).toThrow('搜索内容')
    expect(() => coerceVariables(variables, { query: '茶叶', pages: 11 })).toThrow('搜索页码')
    expect(() => coerceVariables(variables, { query: '茶叶', format: 'xml' })).toThrow('输出格式')
    expect(() => coerceVariables(variables, { query: '茶叶', enabled: 'no' })).toThrow('开启')
    expect(() => coerceVariables(variables, { query: '茶叶', unknown: 1 })).toThrow('未声明')
    expect(variableSchema.safeParse({ key: 'constructor', label: '保留字', kind: 'text' }).success).toBe(false)
    expect(scriptDraftSchema.safeParse({ ...draft, variables: [variables[0], variables[0]] }).success).toBe(false)
    expect(variableSchema.safeParse({ key: 'format', label: '格式', kind: 'enum', options: ['json'], default: 'xml' }).success).toBe(false)
  })
  it('导出 .js 包含参数声明，导入后与原契约一致，不携带本机身份', () => {
    const value = { ...draft, id: randomUUID(), values: { privateInput: '私人参数' } }
    const content = exportScript(scriptDraftSchema.parse(draft))
    expect(content).toContain('// @octo-fetch ')
    expect(importScript(content)).toEqual(draft)
    expect(content).not.toContain(value.id)
    expect(content).not.toContain('私人参数')
    expect(() => importScript('return 1')).toThrow('元数据')
    expect(importScript(content.replace('"version":5', '"version":3'))).toEqual(draft)
    expect(() => importScript(content.replace('"version":5', '"version":6'))).toThrow('版本')
  })
  it('较大的合法源码与变量声明导出后仍可导入，超限文件被拒绝', () => {
    const large = scriptDraftSchema.parse({
      ...draft, source: `//${'示'.repeat(199998)}`,
      variables: Array.from({ length: 30 }, (_, i) => ({ key: `v${i}`, label: '参数', kind: 'text', default: '\n'.repeat(10000) }))
    })
    const content = exportScript(large)
    expect(Buffer.byteLength(content)).toBeGreaterThan(1000000)
    expect(importScript(content)).toEqual(large)
    expect(() => importScript('x'.repeat(MAX_SCRIPT_FILE_BYTES + 1))).toThrow('8MB')
  })
})

describe('脚本落盘与日志轮转', () => {
  it('源码存为 .js，摘要不含源码，重启恢复及修改备份有效', async () => {
    const dir = await directory()
    const store = new ScriptStore(dir); await store.initialize()
    const saved = await store.save(undefined, draft, 'agent')
    await store.remember(saved.id, saved.updatedAt, { query: '上次参数' })
    expect(await readFile(path.join(dir, 'scripts', `${saved.id}.js`), 'utf8')).toContain(draft.source)
    expect(store.list()[0].draft).not.toHaveProperty('source')
    expect(store.list()[0]).not.toHaveProperty('values')
    const restarted = new ScriptStore(dir); await restarted.initialize()
    expect(restarted.get(saved.id)).toMatchObject({ origin: 'agent', values: { query: '上次参数' }, draft })
    await restarted.save(saved.id, { ...draft, name: '新版本' }, 'manual')
    await writeFile(path.join(dir, 'scripts', `${saved.id}.js`), 'broken')
    const recovered = new ScriptStore(dir); await recovered.initialize()
    expect(recovered.get(saved.id).draft.name).toBe('搜索能力')
    expect(recovered.warnings).toHaveLength(1)
    await expect(recovered.save(undefined, { ...draft, source: 'const =' }, 'manual')).rejects.toThrow('语法错误')
  })
  it('损坏脚本不会被静默覆盖，其他脚本继续加载', async () => {
    const dir = await directory()
    const store = new ScriptStore(dir)
    const broken = await store.save(undefined, draft, 'manual')
    const good = await store.save(undefined, draft, 'manual')
    const file = path.join(dir, 'scripts', `${broken.id}.js`)
    await writeFile(file, 'broken')
    const recovered = new ScriptStore(dir); await recovered.initialize()
    expect(recovered.list().map((item) => item.id)).toEqual([good.id])
    expect(await readFile(file, 'utf8')).toBe('broken')
    expect(recovered.warnings).toHaveLength(1)
  })
  it('日志保留最近 20 次，未完成记录重启后变为异常中断', async () => {
    const dir = await directory()
    const logs = new ScriptLogStore(dir)
    const id = randomUUID()
    for (let i = 0; i < MAX_RUNS + 3; i++) await logs.put(record(id, i))
    const recent = await logs.list(id)
    expect(recent).toHaveLength(MAX_RUNS)
    expect(recent[0].startedAt).toBe(new Date((MAX_RUNS + 2) * 1000).toISOString())
    const running = { ...record(id, 100), status: 'running' as const }
    await logs.put(running)
    const recovered = new ScriptLogStore(dir)
    expect((await recovered.list(id))[0]).toMatchObject({ status: 'interrupted', error: expect.stringContaining('未完成') })
    await recovered.clear(id)
    expect(await recovered.list(id)).toEqual([])
  })
})

describe('执行调度与 MCP 脚本工具', () => {
  it('行动依赖未安装时拒绝执行，安装状态完整后传入独立模块目录', async () => {
    const { runner, dir, siteId, inputs } = await fixture()
    try {
      const dependencies = [{ name: 'local-package', version: 'latest' }]
      const script = await runner.save(undefined, { ...draft, dependencies }, 'manual')
      await expect(runner.start({ scriptId: script.id, siteId, values: {} })).rejects.toThrow('手动安装成功')
      const root = path.join(dir, 'script-data', script.id)
      const module = path.join(root, 'node_modules', 'local-package')
      await mkdir(module, { recursive: true })
      await writeFile(path.join(module, 'package.json'), JSON.stringify({ name: 'local-package' }))
      await markDependenciesInstalled(root, dependencies)
      const run = await runner.start({ scriptId: script.id, siteId, values: {} })
      expect(inputs[0].moduleRoot).toBe(root)
      await runner.cancel(run.id)
    } finally { await runner.shutdown() }
  })
  it('拒绝不适用域名与变量，按网站加锁，运行中禁止修改删除，取消后可复用', async () => {
    const { runner, store, siteId, workers } = await fixture()
    try {
      const mismatch = await runner.save(undefined, { ...draft, match: ['other.com'] }, 'manual')
      await expect(runner.start({ scriptId: mismatch.id, siteId, values: {} })).rejects.toThrow('不适用')
      const saved = await runner.save(undefined, draft, 'agent')
      await expect(runner.start({ scriptId: saved.id, siteId, values: { extra: 1 } })).rejects.toThrow('未声明')
      const results = await Promise.allSettled([runner.start({ scriptId: saved.id, siteId, values: {} }), runner.start({ scriptId: saved.id, siteId, values: {} })])
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      await expect(runner.save(saved.id, draft, 'manual')).rejects.toThrow('先停止')
      await expect(runner.remove(saved.id)).rejects.toThrow('先停止')
      await expect(runner.clearLogs(saved.id)).rejects.toThrow('不能清空')
      const run = runner.active()[0]
      workers[0].emit('message', { type: 'log', log: { time: new Date().toISOString(), level: 'warn', text: '正在查找' } })
      expect((await runner.runs(saved.id))[0].logs.some((log) => log.text === '正在查找')).toBe(true)
      await runner.cancel(run.id)
      workers[0].emit('message', { type: 'done', result: '"迟到结果"', dropped: 0 })
      expect((await runner.runs(saved.id))[0]).toMatchObject({ status: 'cancelled' })
      expect(workers[0].terminate).toHaveBeenCalledOnce()
      expect(runner.active()).toEqual([])
      await runner.remove(saved.id)
      expect(store.list()).toHaveLength(1)
    } finally { await runner.shutdown() }
  })
  it('成功、超时、日志上限和异常路径均留下终态', async () => {
    const { runner, siteId, workers } = await fixture()
    try {
      const script = await runner.save(undefined, { ...draft, timeout: 1 }, 'agent')
      await runner.start({ scriptId: script.id, siteId, values: {} })
      for (let i = 0; i < 500; i++) workers[0].emit('message', { type: 'log', log: { time: new Date().toISOString(), level: 'info', text: String(i) } })
      workers[0].emit('message', { type: 'done', result: '{"ok":true}', dropped: 0 })
      await vi.waitFor(() => expect(runner.active()).toHaveLength(0))
      expect((await runner.runs(script.id))[0]).toMatchObject({ status: 'success', result: '{"ok":true}' })
      expect((await runner.runs(script.id))[0].logs).toHaveLength(MAX_LOGS)
      await runner.start({ scriptId: script.id, siteId, values: {} })
      await vi.waitFor(() => expect(runner.active()).toHaveLength(0), { timeout: 2000 })
      expect((await runner.runs(script.id))[0].status).toBe('timeout')
      await runner.start({ scriptId: script.id, siteId, values: {} })
      workers[2].emit('error', new Error('Worker 崩溃'))
      await vi.waitFor(() => expect(runner.active()).toHaveLength(0))
      expect((await runner.runs(script.id))[0]).toMatchObject({ status: 'error', error: 'Worker 崩溃' })
    } finally { await runner.shutdown() }
  })
  it('MCP 从编写契约到保存、读取、运行、结果和删除的完整链路', async () => {
    const { runner, manager, workers, siteId } = await fixture()
    const call = async (name: string, args: unknown = {}) => {
      const content = await TOOLS.find((tool) => tool.name === name)!.run(manager, args, runner)
      return content.map((item) => item.type === 'text' ? item.text : '').join('')
    }
    try {
      expect(await call('script_guide')).toContain('octo.vars')
      const { script_id } = JSON.parse(await call('save_script', { draft }))
      expect(runner.store.get(script_id).origin).toBe('agent')
      expect(await call('list_scripts', { url: 'https://example.com' })).toContain(script_id)
      expect(await call('read_script', { script_id })).toContain('source')
      const { run_id } = JSON.parse(await call('run_script', { script_id, site_id: siteId }))
      workers[0].emit('message', { type: 'done', result: '42', dropped: 0 })
      await vi.waitFor(() => expect(runner.active()).toHaveLength(0))
      expect(JSON.parse(await call('read_script_runs', { script_id, run_id }))[0]).toMatchObject({ id: run_id, status: 'success', result: '42' })
      await expect(call('save_script', { draft, surprise: true })).rejects.toThrow()
      await call('delete_script', { script_id })
      expect(runner.store.list()).toEqual([])
    } finally { await runner.shutdown() }
  })
})
