import type { BrowserManager } from '../../src/main/browser/manager'
import type { NotificationService } from '../../src/main/notifications/service'
import type { PackageInstaller } from '../../src/main/scripts/packages'
import type { SandboxCommand, SandboxInput } from '../../src/shared/sandbox'
import type { ScriptDraft } from '../../src/shared/scripts'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { TOOLS } from '../../src/main/mcp/tools'
import { ScriptRunner } from '../../src/main/scripts/runner'
import { ScriptLogStore, ScriptStore } from '../../src/main/scripts/store'
import { DEFAULT_SETTINGS } from '../../src/shared/model'
import { MAX_SANDBOXES, serializeSandboxOutput } from '../../src/shared/sandbox'
import { exportScript, importScript, runSchema, scriptDraftSchema } from '../../src/shared/scripts'

const draft: ScriptDraft = { kind: 'sandbox', dependencies: [], sandbox: { mode: 'once' }, name: '独立脚本', description: '', match: [], variables: [], timeout: 60, source: 'return 42;' }
class Child extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  commands: SandboxCommand[] = []
  constructor(readonly input: SandboxInput) { super(); setImmediate(() => this.emit('spawn')) }
  postMessage(command: SandboxCommand) {
    this.commands.push(command)
    if (command.type === 'stop') this.message('disposed')
  }
  kill = vi.fn(() => { this.stdout.end(); this.stderr.end(); this.emit('exit', 0); return true })
  message(type: string, extra: Record<string, unknown> = {}) {
    this.emit('message', { type, runId: this.input.runId, logs: [], dropped: 0, ...extra })
  }
}
async function fixture(packageInstaller?: PackageInstaller) {
  const dir = path.join(process.cwd(), '.test-data', randomUUID())
  await mkdir(dir, { recursive: true })
  const store = new ScriptStore(dir), logs = new ScriptLogStore(dir)
  const manager = { scriptSession: vi.fn(), store: { get: () => ({ settings: DEFAULT_SETTINGS }) } } as unknown as BrowserManager
  const children: Child[] = []
  const notifications = { submit: vi.fn() } as unknown as NotificationService
  const runner = new ScriptRunner(store, logs, manager, vi.fn(), undefined, notifications, (input) => {
    const child = new Child(input); children.push(child); return child
  }, undefined, undefined, packageInstaller)
  return { runner, store, logs, manager, children, dir, notifications }
}
const log = (text: string) => ({ time: new Date().toISOString(), level: 'info', text })

describe('沙箱契约与兼容', () => {
  it('沙箱不绑定网站；行动注入仍要求域名且不能携带沙箱配置', () => {
    expect(scriptDraftSchema.parse(draft)).toEqual(draft)
    expect(scriptDraftSchema.safeParse({ ...draft, match: ['example.com'] }).success).toBe(false)
    expect(scriptDraftSchema.safeParse({ ...draft, sandbox: undefined }).success).toBe(false)
    for (const kind of ['action', 'injection']) {
      expect(scriptDraftSchema.safeParse({ ...draft, kind }).success).toBe(false)
      expect(scriptDraftSchema.safeParse({ ...draft, kind, match: ['example.com'] }).success).toBe(false)
      expect(scriptDraftSchema.safeParse({ ...draft, kind, match: ['example.com'], sandbox: undefined }).success).toBe(true)
    }
  })
  it('依赖只接受 registry 包与 semver/dist-tag，拒绝重复包名和外部来源', () => {
    expect(scriptDraftSchema.parse({ ...draft, dependencies: [{ name: '@scope/pkg', version: 'next' }, { name: 'lodash', version: '^4.17.21' }] }).dependencies).toHaveLength(2)
    expect(scriptDraftSchema.safeParse({ ...draft, dependencies: [{ name: 'lodash', version: 'latest' }, { name: 'lodash', version: '^4' }] }).success).toBe(false)
    for (const version of ['git+https://example.com/repo.git', 'file:../pkg', 'https://example.com/pkg.tgz']) {
      expect(scriptDraftSchema.safeParse({ ...draft, dependencies: [{ name: 'pkg', version }] }).success).toBe(false)
    }
  })
  it('脚本以版本 5 导出，旧文件仍默认行动，v4 沙箱依赖自动迁移', () => {
    for (const mode of ['once', 'service'] as const) {
      const value: ScriptDraft = { ...draft, dependencies: [{ name: 'lodash', version: '^4.17.21' }], sandbox: { mode } }
      expect(exportScript(value)).toContain('"version":5')
      expect(importScript(exportScript(value))).toEqual(value)
    }
    const legacy = '// @octo-fetch {"version":1,"name":"旧脚本","match":["example.com"]}\nreturn 1;'
    expect(importScript(legacy).kind).toBe('action')
    const legacySandbox = `// @octo-fetch {"version":4,"kind":"sandbox","name":"旧沙箱","description":"","match":[],"variables":[],"sandbox":{"mode":"once","dependencies":[{"name":"lodash","version":"^4.17.21"}]},"timeout":60}\nreturn 1;`
    expect(importScript(legacySandbox)).toMatchObject({ dependencies: [{ name: 'lodash', version: '^4.17.21' }], sandbox: { mode: 'once' } })
  })
  it('输出允许 JSON 标量、对象、数组和 null，拒绝非法值与超长结果', () => {
    for (const value of [null, false, 0, '文本', [], { value: 42 }]) expect(JSON.parse(serializeSandboxOutput(value))).toEqual(value)
    const circular: Record<string, unknown> = {}; circular.self = circular
    for (const value of [undefined, { x: undefined }, [undefined], 1n, { x: () => 1 }, Symbol('x'), NaN, Infinity, circular, 'x'.repeat(65536)]) expect(() => serializeSandboxOutput(value)).toThrow()
  })
})

describe('沙箱调度、持久化及 MCP', () => {
  it('安装声明依赖时按脚本互斥，并传入独立目录与全局 registry', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const installer = vi.fn<PackageInstaller>(async (_cwd, _dependencies, _registry, signal) => {
      await Promise.race([pending, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))])
      return signal.aborted ? { ok: false, logs: '', error: '依赖安装已取消' } : { ok: true, logs: 'installed' }
    })
    const f = await fixture(installer)
    try {
      const script = await f.runner.save(undefined, { ...draft, dependencies: [{ name: 'lodash', version: '^4.17.21' }], sandbox: { mode: 'once' } }, 'manual')
      const installing = f.runner.installDependencies(script.id)
      await vi.waitFor(() => expect(installer).toHaveBeenCalledOnce())
      expect(installer.mock.calls[0][0]).toBe(path.join(f.dir, 'sandbox-data', script.id))
      expect(installer.mock.calls[0][1]).toEqual([{ name: 'lodash', version: '^4.17.21' }])
      expect(installer.mock.calls[0][2]).toBe(DEFAULT_SETTINGS.sandboxRegistry)
      await expect(f.runner.start({ scriptId: script.id, values: {} })).rejects.toThrow('安装依赖')
      await expect(f.runner.save(script.id, script.draft, 'manual')).rejects.toThrow('安装中')
      await expect(f.runner.remove(script.id)).rejects.toThrow('安装中')
      release()
      await expect(installing).resolves.toEqual({ ok: true, logs: 'installed' })
      const action = await f.runner.save(undefined, { ...draft, kind: 'action', dependencies: [{ name: 'nanoid', version: 'latest' }], sandbox: undefined, match: ['example.com'] }, 'manual')
      await expect(f.runner.installDependencies(action.id)).resolves.toEqual({ ok: true, logs: 'installed' })
      expect(installer).toHaveBeenLastCalledWith(path.join(f.dir, 'script-data', action.id), [{ name: 'nanoid', version: 'latest' }], DEFAULT_SETTINGS.sandboxRegistry, expect.any(AbortSignal))
    } finally { release(); await f.runner.shutdown() }
  })
  it('有依赖时仅安装成功且依赖文件完整后允许启动', async () => {
    const installer = vi.fn<PackageInstaller>(async (cwd, dependencies) => {
      for (const dependency of dependencies) {
        const directory = path.join(cwd, 'node_modules', ...dependency.name.split('/'))
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: dependency.name }))
      }
      return { ok: true, logs: 'installed' }
    })
    const f = await fixture(installer)
    try {
      const script = await f.runner.save(undefined, { ...draft, dependencies: [{ name: 'lodash', version: '^4.17.21' }], sandbox: { mode: 'once' } }, 'manual')
      await expect(f.runner.start({ scriptId: script.id, values: {} })).rejects.toThrow('手动安装成功')
      await expect(f.runner.installDependencies(script.id)).resolves.toEqual({ ok: true, logs: 'installed' })
      const run = await f.runner.start({ scriptId: script.id, values: {} })
      await f.runner.cancel(run.id)
      await rm(path.join(f.dir, 'sandbox-data', script.id, 'node_modules', 'lodash', 'package.json'))
      await expect(f.runner.start({ scriptId: script.id, values: {} })).rejects.toThrow('手动安装成功')
      await f.runner.installDependencies(script.id)
      await f.runner.save(script.id, { ...script.draft, dependencies: [{ name: 'lodash', version: '^5.0.0' }], sandbox: { mode: 'once' } }, 'manual')
      await expect(f.runner.start({ scriptId: script.id, values: {} })).rejects.toThrow('手动安装成功')
      installer.mockResolvedValueOnce({ ok: false, logs: 'failed', error: 'npm install 失败' })
      await expect(f.runner.installDependencies(script.id)).resolves.toMatchObject({ ok: false })
      await expect(f.runner.start({ scriptId: script.id, values: {} })).rejects.toThrow('手动安装成功')
    } finally { await f.runner.shutdown() }
  })
  it('无网站执行，入参校验、单实例与全局并发限制、运行中保护', async () => {
    const f = await fixture()
    try {
      const script = await f.runner.save(undefined, draft, 'manual')
      await expect(f.runner.start({ scriptId: script.id, siteId: randomUUID(), values: {} })).rejects.toThrow('不能指定')
      await expect(f.runner.start({ scriptId: script.id, values: { unknown: 1 } })).rejects.toThrow('未声明')
      const results = await Promise.allSettled([f.runner.start({ scriptId: script.id, values: {} }), f.runner.start({ scriptId: script.id, values: {} })])
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      expect(f.manager.scriptSession).not.toHaveBeenCalled()
      await expect(f.runner.save(script.id, draft, 'manual')).rejects.toThrow('先停止')
      await expect(f.runner.remove(script.id)).rejects.toThrow('先停止')
      await expect(f.runner.clearLogs(script.id)).rejects.toThrow('不能清空')
      for (let index = 1; index < MAX_SANDBOXES; index++) {
        const next = await f.runner.save(undefined, draft, 'manual')
        await f.runner.start({ scriptId: next.id, values: {} })
      }
      const excess = await f.runner.save(undefined, draft, 'manual')
      await expect(f.runner.start({ scriptId: excess.id, values: {} })).rejects.toThrow('4 个')
      await f.runner.cancel(f.runner.active()[0].id)
      await f.runner.start({ scriptId: script.id, values: {} })
      expect(f.runner.active()).toHaveLength(4)
      const action = await f.runner.save(undefined, { ...draft, kind: 'action', sandbox: undefined, match: ['example.com'] }, 'manual')
      await expect(f.runner.start({ scriptId: action.id, values: {} })).rejects.toThrow('必须选择网站')
    } finally { await f.runner.shutdown() }
  })
  it('错误身份与非法消息忽略；一次性成功输出，停止时仅收尾一次', async () => {
    const f = await fixture()
    try {
      const script = await f.runner.save(undefined, draft, 'manual')
      const run = await f.runner.start({ scriptId: script.id, values: {} })
      const child = f.children[0]
      child.message('done', { runId: randomUUID(), nodeVersion: '22', result: '1' })
      child.message('batch', { logs: [log('x'.repeat(2001))] })
      expect(f.runner.active()).toHaveLength(1)
      child.message('done', { nodeVersion: '22', result: '{"ok":true}' })
      await vi.waitFor(() => expect(f.runner.active()).toHaveLength(0))
      child.message('failed', { error: '迟到异常' })
      expect((await f.runner.runs(script.id))[0]).toMatchObject({ id: run.id, status: 'success', result: '{"ok":true}', phase: 'stopped', endReason: 'completed' })
      expect(child.kill).toHaveBeenCalledOnce()
      const savedRun = (await f.runner.runs(script.id))[0]
      expect(runSchema.safeParse({ ...savedRun, siteId: randomUUID() }).success).toBe(false)
      expect(runSchema.safeParse({ ...savedRun, kind: 'action' }).success).toBe(false)
    } finally { await f.runner.shutdown() }
  })
  it('常驻返回后取消初始化计时，持续保存最新日志与结果，停止保留快照', async () => {
    const f = await fixture()
    try {
      const script = await f.runner.save(undefined, { ...draft, sandbox: { mode: 'service' }, timeout: 1 }, 'manual')
      const run = await f.runner.start({ scriptId: script.id, values: {} })
      f.children[0].message('ready', { nodeVersion: '22', result: '{"count":0}' })
      for (let batch = 0; batch < 4; batch++) f.children[0].message('batch', { logs: Array.from({ length: 100 }, (_, i) => log(String(batch * 100 + i))), result: JSON.stringify({ count: batch }) })
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(f.runner.active()[0].phase).toBe('active')
      expect(f.children[0].commands.filter((item) => item.type === 'ack')).toHaveLength(4)
      const record = (await f.runner.runs(script.id))[0]
      expect(record.logs).toHaveLength(300)
      expect(record.logs.at(-1)?.text).toBe('399')
      expect(record.droppedLogs).toBeGreaterThan(0)
      await Promise.all([f.runner.cancel(run.id), f.runner.cancel(run.id)])
      expect(f.children[0].kill).toHaveBeenCalledOnce()
      expect((await f.runner.runs(script.id))[0]).toMatchObject({ status: 'cancelled', endReason: 'user', result: '{"count":3}' })
      expect(JSON.parse(await readFile(path.join(f.dir, 'script-logs', `${script.id}.json`), 'utf8'))[0].result).toBe('{"count":3}')
    } finally { await f.runner.shutdown() }
  })
  it('常驻初始化超时，非预期正常退出仍为失败，一次性停止不保留结果', async () => {
    const f = await fixture()
    try {
      const script = await f.runner.save(undefined, { ...draft, sandbox: { mode: 'service' }, timeout: 1 }, 'manual')
      await f.runner.start({ scriptId: script.id, values: {} })
      await vi.waitFor(() => expect(f.runner.active()).toHaveLength(0), { timeout: 2500 })
      expect((await f.runner.runs(script.id))[0]).toMatchObject({ status: 'timeout', endReason: 'timeout' })
      await f.runner.save(script.id, draft, 'manual')
      await f.runner.start({ scriptId: script.id, values: {} })
      f.children[1].message('batch', { result: '42' })
      f.children[1].emit('exit', 0)
      await vi.waitFor(() => expect(f.runner.active()).toHaveLength(0))
      expect((await f.runner.runs(script.id))[0]).toMatchObject({ status: 'error', error: expect.stringContaining('意外退出') })
      expect((await f.runner.runs(script.id))[0].result).toBeUndefined()
    } finally { await f.runner.shutdown() }
  })
  it('落盘失败保留内存结果并告警，重启残留记录标为异常中断', async () => {
    const f = await fixture()
    try {
      const script = await f.runner.save(undefined, { ...draft, sandbox: { mode: 'service' } }, 'manual')
      await f.runner.start({ scriptId: script.id, values: {} })
      f.children[0].message('ready', { nodeVersion: '22', result: '7' })
      const put = vi.spyOn(f.logs, 'put').mockRejectedValue(new Error('磁盘已满'))
      f.children[0].message('failed', { error: '测试失败', result: '8' })
      await vi.waitFor(() => expect(f.runner.active()).toHaveLength(0))
      expect((await f.runner.runs(script.id))[0]).toMatchObject({ status: 'error', result: '8' })
      expect(f.runner.sandbox.persistenceError).toContain('写入失败')
      put.mockRestore()
      const restored = new ScriptLogStore(f.dir)
      expect((await restored.list(script.id))[0]).toMatchObject({ status: 'interrupted', phase: 'stopped', endReason: 'interrupted' })
    } finally { await f.runner.shutdown() }
  })
  it('停止时收下尚未批发的常驻快照，慢磁盘期间合并写入', async () => {
    const f = await fixture()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    try {
      const script = await f.runner.save(undefined, { ...draft, sandbox: { mode: 'service' } }, 'manual')
      const run = await f.runner.start({ scriptId: script.id, values: {} })
      const originalPut = f.logs.put.bind(f.logs)
      const put = vi.spyOn(f.logs, 'put').mockImplementationOnce(async (record) => { await blocked; await originalPut(record) })
      f.children[0].message('ready', { nodeVersion: '24', result: '1' })
      await vi.waitFor(() => expect(put).toHaveBeenCalledOnce(), { timeout: 1000 })
      for (let i = 0; i < 3; i++) {
        f.children[0].message('batch', { result: String(i + 2) })
        await new Promise((resolve) => setTimeout(resolve, 550))
      }
      expect(put).toHaveBeenCalledOnce()
      const child = f.children[0]
      vi.spyOn(child, 'postMessage').mockImplementation((command) => { if (command.type === 'stop') child.message('disposed', { result: '99' }) })
      const stopped = f.runner.cancel(run.id)
      release()
      await stopped
      expect(put).toHaveBeenCalledTimes(2)
      expect((await f.runner.runs(script.id))[0]).toMatchObject({ status: 'cancelled', result: '99' })
    } finally { release(); await f.runner.shutdown() }
  })
  it('MCP 保存、过滤、无网站运行、结果和停止；通知带沙箱来源', async () => {
    const f = await fixture()
    const call = async (name: string, args: unknown = {}) => {
      const reply = await TOOLS.find((item) => item.name === name)!.run(f.manager, args, f.runner)
      return reply.map((item) => item.type === 'text' ? item.text : '').join('')
    }
    try {
      expect(await call('script_guide')).toContain('sandbox_service')
      const { script_id } = JSON.parse(await call('save_script', { draft: { ...draft, sandbox: { mode: 'service' } } }))
      expect(await call('list_scripts', { url: 'https://example.com', kind: 'sandbox' })).toContain(script_id)
      const { run_id } = JSON.parse(await call('run_script', { script_id }))
      f.children[0].message('ready', { nodeVersion: '22', result: '42' })
      f.children[0].emit('message', { type: 'notify', runId: run_id, request: { id: randomUUID(), targets: ['ops'], message: { title: '测试', content: '内容' } } })
      expect(f.notifications.submit).toHaveBeenCalledWith(expect.anything(), { kind: 'sandbox', scriptId: script_id, runId: run_id })
      expect(JSON.parse(await call('read_script_runs', { script_id, run_id }))[0]).toMatchObject({ phase: 'active', result: '42' })
      await call('cancel_script_run', { run_id })
      expect(JSON.parse(await call('read_script_runs', { script_id, run_id }))[0].status).toBe('cancelled')
      await call('delete_script', { script_id })
      expect(f.store.list()).toHaveLength(0)
      for (const name of ['save_script', 'install_dependencies', 'run_script', 'cancel_script_run', 'delete_script']) expect(TOOLS.find((tool) => tool.name === name)?.level).toBe('full')
    } finally { await f.runner.shutdown() }
  })
})
