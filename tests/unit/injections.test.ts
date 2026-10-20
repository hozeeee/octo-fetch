import type { Protocol } from 'devtools-protocol'
import type { Worker } from 'node:worker_threads'
import type { Page } from 'puppeteer-core'
import type { CookieVault } from '../../src/main/storage/store'
import type { Hook, InjectionCommand, NetworkRequest } from '../../src/shared/injections'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bodyHeaders, PageInterception, responseSkipReason } from '../../src/main/browser/interception'
import { BrowserManager } from '../../src/main/browser/manager'
import { TOOLS } from '../../src/main/mcp/tools'
import { InjectionService, InjectionSession } from '../../src/main/scripts/injections'
import { ScriptRunner } from '../../src/main/scripts/runner'
import { ScriptLogStore, ScriptStore } from '../../src/main/scripts/store'
import { ConfigStore } from '../../src/main/storage/store'
import { bindingFingerprint, injectionBindingsSchema, MAX_RESPONSE_BYTES } from '../../src/shared/injections'
import { commandSchema, siteDraftSchema } from '../../src/shared/model'
import { exportScript, importScript, scriptDraftSchema } from '../../src/shared/scripts'

const draft = scriptDraftSchema.parse({ kind: 'injection', name: '接口注入', match: ['example.com'], source: 'return;' })
const binding = (scriptId: string) => ({ scriptId, enabled: true, values: {} })
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-injections-'))
  const config = new ConfigStore(dir), store = new ScriptStore(dir), logs = new ScriptLogStore(dir)
  const manager = new BrowserManager(config, {} as CookieVault, '', vi.fn(), vi.fn())
  const runner = new ScriptRunner(store, logs, manager, vi.fn())
  const service = new InjectionService(store, logs, config, vi.fn(), undefined, undefined, undefined, runner.packages)
  manager.injections = service
  const script = await runner.save(undefined, draft, 'manual')
  const siteId = await manager.saveSite(undefined, { name: '测试网站', url: 'https://example.com', injections: [binding(script.id)] })
  return { dir, config, store, logs, service, manager, runner, script, site: config.site(siteId) }
}
afterEach(() => vi.useRealTimers())

describe('分类兼容与绑定服务', () => {
  it('旧脚本、旧配置与 v1 导出默认行动，v2 两类均可往返', async () => {
    const f = await fixture()
    try {
      const file = path.join(f.dir, 'scripts', `${f.script.id}.js`)
      await writeFile(file, (await readFile(file, 'utf8')).replace('"kind":"injection",', ''))
      const restored = new ScriptStore(f.dir); await restored.initialize()
      expect(restored.get(f.script.id)).toMatchObject({ id: f.script.id, createdAt: f.script.createdAt, updatedAt: f.script.updatedAt, draft: { kind: 'action' } })
      expect(siteDraftSchema.parse({ name: '旧配置', url: 'https://example.com' }).injections).toEqual([])
      expect(importScript(exportScript(draft).replace('"version":2', '"version":1').replace('"kind":"injection",', '')).kind).toBe('action')
      for (const kind of ['action', 'injection'] as const) expect(importScript(exportScript({ ...draft, kind }))).toEqual({ ...draft, kind })
    } finally { await f.manager.shutdown() }
  })
  it('参数保存与日志不改版本，编辑保留创建时间并推进版本', async () => {
    const f = await fixture()
    try {
      await f.store.remember(f.script.id, f.script.updatedAt, {})
      expect(f.store.get(f.script.id)).toMatchObject({ updatedAt: f.script.updatedAt, createdAt: f.script.createdAt })
      const next = await f.runner.save(f.script.id, { ...draft, source: 'return 2;' }, 'manual')
      expect(next.createdAt).toBe(f.script.createdAt)
      expect(next.updatedAt > f.script.updatedAt).toBe(true)
      expect(bindingFingerprint(f.site.injections, [next])).not.toBe(bindingFingerprint(f.site.injections, [f.script]))
    } finally { await f.manager.shutdown() }
  })
  it('统一校验引用、类型、域名、变量、重复绑定，禁止行动运行与删除绑定注入', async () => {
    const f = await fixture()
    try {
      expect(() => f.service.validate([binding(randomUUID())], f.site.url)).toThrow('注入')
      expect(() => f.service.validate(f.site.injections, 'https://wrong.com')).toThrow('适用域名')
      expect(() => f.service.validate([{ ...binding(f.script.id), values: { unknown: 1 } }], f.site.url)).toThrow('未声明')
      expect(() => injectionBindingsSchema.parse([...f.site.injections, ...f.site.injections])).toThrow('重复')
      await expect(f.runner.start({ scriptId: f.script.id, siteId: f.site.id, values: {} })).rejects.toThrow('页面管理')
      await expect(f.runner.remove(f.script.id)).rejects.toThrow('测试网站')
      await expect(f.runner.save(f.script.id, { ...draft, kind: 'action' }, 'manual')).rejects.toThrow('测试网站')
      const action = await f.runner.save(undefined, { ...draft, kind: 'action' }, 'manual')
      await expect(f.manager.saveSite(f.site.id, { name: f.site.name, url: f.site.url, injections: [binding(action.id)] })).rejects.toThrow('只能绑定')
      await f.manager.saveSite(f.site.id, { name: '更新名称', url: f.site.url })
      expect(f.config.site(f.site.id).injections).toEqual(f.site.injections)
      await f.manager.saveSite(f.site.id, { name: f.site.name, url: f.site.url, injections: [] })
      await f.runner.remove(f.script.id)
      expect(f.store.list()).toHaveLength(1)
    } finally { await f.manager.shutdown() }
  })
  it('IPC 省略绑定保留语义，快照识别参数、顺序、启停而忽略键顺序', () => {
    const id = randomUUID(), other = randomUUID()
    const parsed = commandSchema.parse({ type: 'site.save', id, draft: { name: '改名', url: 'https://example.com' } })
    expect(parsed).not.toHaveProperty('draft.injections')
    const bindings = [{ ...binding(id), values: { a: 1, b: 2 } }, binding(other)]
    const fingerprint = bindingFingerprint(bindings, [])
    expect(bindingFingerprint([{ ...bindings[0], values: { b: 2, a: 1 } }, bindings[1]], [])).toBe(fingerprint)
    for (const changed of [[...bindings].reverse(), [{ ...bindings[0], enabled: false }, bindings[1]], [{ ...bindings[0], values: { a: 3, b: 2 } }, bindings[1]]]) {
      expect(bindingFingerprint(changed, [])).not.toBe(fingerprint)
    }
  })
  it('注入使用独立模块目录，依赖未安装时拒绝启动网站', async () => {
    const f = await fixture()
    try {
      await f.runner.save(f.script.id, { ...draft, dependencies: [{ name: 'local-package', version: 'latest' }] }, 'manual')
      expect(f.service.validate(f.site.injections, f.site.url)[0].moduleRoot).toBe(path.join(f.dir, 'script-data', f.script.id))
      await expect(f.service.begin(f.site, 'ws://unused', vi.fn())).rejects.toThrow('手动安装成功')
      expect(f.service.session(f.site.id)).toBeUndefined()
    } finally { await f.manager.shutdown() }
  })
  it('启动重新校验脚本变化导致的失效绑定，不建立 Worker 会话', async () => {
    const f = await fixture()
    try {
      await f.runner.save(f.script.id, { ...draft, match: ['other.test'] }, 'manual')
      await expect(f.service.begin(f.site, 'ws://unused', vi.fn())).rejects.toThrow('适用域名')
      await f.runner.save(f.script.id, { ...draft, variables: [{ key: 'required', label: '必要参数', kind: 'text', required: true }] }, 'manual')
      await expect(f.service.begin(f.site, 'ws://unused', vi.fn())).rejects.toThrow('必要参数')
      expect(f.service.session(f.site.id)).toBeUndefined()
    } finally { await f.manager.shutdown() }
  })
  it('MCP 旧保存默认行动，类型筛选、绑定保留及列表不泄漏参数', async () => {
    const f = await fixture()
    const call = async (name: string, args: unknown = {}) => {
      const result = await TOOLS.find((tool) => tool.name === name)!.run(f.manager, args, f.runner)
      return JSON.parse(result.filter((item) => item.type === 'text').map((item) => item.text).join(''))
    }
    try {
      const { kind: _kind, ...legacy } = draft
      const saved = await call('save_script', { draft: legacy })
      expect(f.store.get(saved.script_id).draft.kind).toBe('action')
      expect(JSON.stringify(await call('list_scripts', { kind: 'injection' }))).toContain(f.script.id)
      expect(JSON.stringify(await call('list_scripts', { kind: 'action' }))).not.toContain(f.script.id)
      await call('save_site', { site_id: f.site.id, name: 'MCP 更新', url: f.site.url })
      expect(f.config.site(f.site.id).injections).toHaveLength(1)
      expect((await call('list_sites'))[0].injections).toEqual([{ scriptId: f.script.id, enabled: true }])
    } finally { await f.manager.shutdown() }
  })
})

async function sessionFixture() {
  const f = await fixture()
  const second = await f.store.save(undefined, { ...draft, name: '第二个' }, 'manual')
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(0) })
  worker.postMessage.mockImplementation((command: InjectionCommand) => queueMicrotask(() => {
    if (command.type === 'dataReply' || command.type === 'captureReply') return
    if (command.type === 'install') worker.emit('message', { type: 'initialized', scriptId: command.scriptId, tabId: command.tabId })
    worker.emit('message', { type: 'reply', id: command.id })
  }))
  const scripts = [f.script, second].map((script) => ({ script, values: {}, moduleRoot: path.join(f.dir, 'script-data', script.id) }))
  const session = new InjectionSession(f.site, 'snapshot', scripts, 'ws://test', f.service, vi.fn(), () => worker as unknown as Worker)
  return { ...f, session, worker, scripts }
}
describe('常驻会话监督', () => {
  it('初始化按绑定顺序且并发去重，标签清理及停止后忽略迟到钩子', async () => {
    const f = await sessionFixture()
    try {
      await f.session.ready()
      const tabId = randomUUID()
      await Promise.all([f.session.install(tabId, 'target', f.site.url), f.session.install(tabId, 'target', f.site.url)])
      await f.session.install(tabId, 'target', f.site.url)
      expect(f.worker.postMessage.mock.calls.map(([c]) => c).filter((c) => c.type === 'install').map((c) => c.scriptId)).toEqual(f.scripts.map((entry) => entry.script.id))
      expect(f.session.states().every((item) => item.phase === 'active')).toBe(true)
      const hook: Hook = { id: 'hook', tabId, scriptId: f.script.id, stage: 'request', urlPattern: '*' }
      f.worker.emit('message', { type: 'hook', hook })
      expect(f.session.hooks.size).toBe(1)
      await f.session.disposeTab(tabId, 'target')
      f.worker.emit('message', { type: 'hook', hook })
      expect(f.session.hooks.size).toBe(0)
      await f.session.stop()
      expect(f.session.states().every((item) => item.phase === 'stopped')).toBe(true)
      expect((await f.logs.list(f.script.id))[0].logs.some((log) => log.tabId === tabId)).toBe(true)
      expect(f.store.get(f.script.id).updatedAt).toBe(f.script.updatedAt)
    } finally { await f.session.stop(); await f.manager.shutdown() }
  })
  it('初始化期限结束后保持常驻，心跳失联才终止', async () => {
    vi.useFakeTimers()
    const f = await sessionFixture()
    try {
      await f.session.install(randomUUID(), 'target', f.site.url)
      for (let elapsed = 0; elapsed <= draft.timeout; elapsed++) {
        await vi.advanceTimersByTimeAsync(1000)
        f.worker.emit('message', { type: 'heartbeat' })
      }
      expect(f.session.states().every((item) => item.phase === 'active')).toBe(true)
      await vi.advanceTimersByTimeAsync(11000)
      expect(f.session.states().every((item) => item.phase === 'disabled')).toBe(true)
      expect(f.worker.terminate).toHaveBeenCalled()
    } finally { vi.useRealTimers(); await f.session.stop(); await f.manager.shutdown() }
  })
  it('Worker 启动使用就绪期限，成功后仍按运行心跳期限监督', async () => {
    vi.useFakeTimers()
    const f = await sessionFixture()
    try {
      f.worker.postMessage.mockImplementation((command: InjectionCommand) => {
        if (command.type === 'ready') setTimeout(() => f.worker.emit('message', { type: 'reply', id: command.id }), 12000)
      })
      const ready = f.session.ready()
      const result = ready.then(() => 'ready', (error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(12000)
      expect(await result).toBe('ready')
      expect(f.worker.terminate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(11000)
      expect(f.worker.terminate).toHaveBeenCalledOnce()
      expect(f.session.states().every((item) => item.error?.includes('无响应'))).toBe(true)
    } finally { vi.useRealTimers(); await f.session.stop(); await f.manager.shutdown() }
  })
  it('Worker 就绪期限耗尽即拒绝并回收，不无限等待首次心跳', async () => {
    vi.useFakeTimers()
    const f = await sessionFixture()
    try {
      f.worker.postMessage.mockImplementation(() => undefined)
      const result = f.session.ready().then(() => 'ready', (error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(14000)
      expect(f.worker.terminate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(await result).toContain('超时')
      expect(f.worker.terminate).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers(); await f.session.stop(); await f.manager.shutdown() }
  })
  it('异常中断恢复注入日志，保留会话版本和标签信息', async () => {
    const f = await sessionFixture()
    try {
      const tabId = randomUUID()
      await f.session.install(tabId, 'target', f.site.url)
      await f.logs.put(f.session.records.get(f.script.id)!)
      const [recovered] = await new ScriptLogStore(f.dir).list(f.script.id)
      expect(recovered).toMatchObject({ kind: 'injection', phase: 'disabled', status: 'interrupted', revision: f.script.updatedAt, tabId })
      expect(recovered.logs.some((log) => log.tabId === tabId)).toBe(true)
    } finally { await f.session.stop(); await f.manager.shutdown() }
  })
  it('Worker 崩溃拒绝等待中的 RPC，停用全部且保留错误日志', async () => {
    const f = await sessionFixture()
    try {
      f.worker.postMessage.mockImplementation(() => undefined)
      const pending = f.session.rpc({ type: 'ready' })
      const rejected = expect(pending).rejects.toThrow('崩溃')
      f.worker.emit('error', new Error('崩溃'))
      await rejected
      expect(f.session.states().every((item) => item.phase === 'disabled')).toBe(true)
      expect(f.worker.terminate).toHaveBeenCalled()
    } finally { await f.session.stop(); await f.manager.shutdown() }
  })
  it('初始化超时终止 Worker，不返回可导航的就绪状态', async () => {
    const f = await sessionFixture()
    try {
      vi.useFakeTimers()
      f.worker.postMessage.mockImplementation(() => undefined)
      const pending = f.session.install(randomUUID(), 'stuck', f.site.url)
      const rejected = expect(pending).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(draft.timeout * 1000 + 1)
      await rejected
      expect(f.session.states().every((item) => item.phase === 'disabled')).toBe(true)
    } finally { vi.useRealTimers(); await f.session.stop(); await f.manager.shutdown() }
  })
})

const original: NetworkRequest = { url: 'https://api.other.test/data', method: 'POST', headers: [{ name: 'Content-Length', value: '3' }], postData: 'old', resourceType: 'Fetch' }
const jsonHeaders = [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }, { name: 'Content-Encoding', value: 'gzip' }]
async function networkFixture(stage: Hook['stage'], handlers: ((payload: unknown) => unknown)[]) {
  const client = Object.assign(new EventEmitter(), { send: vi.fn().mockResolvedValue({}), detach: vi.fn().mockResolvedValue(undefined) })
  client.send.mockImplementation(async (name: string) => name === 'Fetch.getResponseBody' ? { body: '{"original":true}', base64Encoded: false } : {})
  const scripts = handlers.map((_, i) => ({ script: { id: `script-${i}` } }))
  const hooks = new Map(handlers.map((_, i): [string, Hook] => [String(i), { id: String(i), scriptId: scripts[i].script.id, tabId: 'tab', stage, urlPattern: '*' }]).reverse())
  const injection = { scripts, hooks, rpc: vi.fn(async (c: { hookId: string; payload: unknown }) => handlers[Number(c.hookId)](structuredClone(c.payload))), disable: vi.fn((id: string) => {
    for (const [key, hook] of hooks) {
      if (hook.scriptId === id) hooks.delete(key)
    }
  }), notice: vi.fn() }
  const interception = new PageInterception({ createCDPSession: async () => client } as unknown as Page, 'tab', injection as unknown as InjectionSession, vi.fn())
  await interception.start()
  const event = { frameId: 'frame', requestId: randomUUID(), request: { ...original, headers: { 'Content-Length': '3' }, initialPriority: 'High', referrerPolicy: 'no-referrer' }, resourceType: 'Fetch', ...(stage === 'response' ? { responseStatusCode: 200, responseHeaders: jsonHeaders } : {}) } as Protocol.Fetch.RequestPausedEvent
  const complete = () => client.send.mock.calls.filter(([name]) => ['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest'].includes(name))
  return { client, injection, interception, event, complete }
}
describe('统一 CDP 拦截调度', () => {
  it('按绑定顺序改 URL、头和正文，同一暂停事件仅完成一次', async () => {
    const f = await networkFixture('request', [() => ({ url: 'https://api.other.test/new', postData: '新正文' }), (payload) => { expect(payload).toMatchObject({ url: 'https://api.other.test/new', postData: '新正文' }); return { headers: [{ name: 'X-Test', value: '1' }] } }])
    try {
      f.client.emit('Fetch.requestPaused', f.event); f.client.emit('Fetch.requestPaused', f.event)
      await vi.waitFor(() => expect(f.complete()).toHaveLength(1))
      expect(f.complete()[0]).toEqual(['Fetch.continueRequest', expect.objectContaining({ url: 'https://api.other.test/new', postData: Buffer.from('新正文').toString('base64'), headers: [{ name: 'X-Test', value: '1' }] })])
    } finally { await f.interception.stop() }
  })
  it('真实响应只读取一次，保留重复 Cookie 并修复编码长度', async () => {
    const f = await networkFixture('response', [(payload) => { expect(payload).toMatchObject({ response: { body: '{"original":true}' } }); return { body: '{"changed":true}' } }])
    try {
      f.client.emit('Fetch.requestPaused', f.event)
      await vi.waitFor(() => expect(f.complete()).toHaveLength(1))
      const params = f.complete()[0][1] as unknown as Protocol.Fetch.FulfillRequestRequest
      expect(f.complete()[0][0]).toBe('Fetch.fulfillRequest')
      expect(Buffer.from(params.body!, 'base64').toString()).toBe('{"changed":true}')
      expect(params.responseHeaders!.filter((header) => header.name === 'Set-Cookie')).toHaveLength(2)
      expect(params.responseHeaders!.some((header) => header.name === 'Content-Encoding')).toBe(false)
      expect(f.client.send.mock.calls.filter(([name]) => name === 'Fetch.getResponseBody')).toHaveLength(1)
    } finally { await f.interception.stop() }
  })
  it.each(['request', 'response'] as const)('%s 处理异常回退原请求并停用故障钩子', async (stage) => {
    const f = await networkFixture(stage, [() => stage === 'response' ? { body: '前一步修改' } : { postData: 'changed' }, () => { throw new Error('故障') }])
    try {
      f.client.emit('Fetch.requestPaused', f.event)
      await vi.waitFor(() => expect(f.complete()).toHaveLength(1))
      expect(f.complete()[0][0]).toBe('Fetch.continueRequest')
      expect(f.injection.disable).toHaveBeenCalled()
      expect(f.complete()[0][1]).not.toHaveProperty('body')
    } finally { await f.interception.stop() }
  })
  it('模拟响应为终结决定，非法导航协议不能被脚本放行', async () => {
    const f = await networkFixture('request', [() => ({ respond: { status: 200, body: '模拟' } }), () => { throw new Error('不应执行') }])
    try {
      f.client.emit('Fetch.requestPaused', f.event)
      await vi.waitFor(() => expect(f.complete()).toHaveLength(1))
      expect(f.complete()[0][0]).toBe('Fetch.fulfillRequest')
      expect(f.injection.rpc).toHaveBeenCalledOnce()
      f.client.emit('Fetch.requestPaused', { ...f.event, requestId: 'unsafe', resourceType: 'Document', request: { ...f.event.request, url: 'file:///private' } })
      await vi.waitFor(() => expect(f.complete()).toHaveLength(2))
      expect(f.complete()[1][0]).toBe('Fetch.failRequest')
    } finally { await f.interception.stop() }
  })
  it('多个处理器共用十秒预算，超时回退且迟到结果不会重复完成', async () => {
    const f = await networkFixture('request', [() => ({}), () => ({})])
    try {
      vi.useFakeTimers()
      const budgets: number[] = []
      f.injection.rpc.mockImplementation((command, ...rest: unknown[]) => {
        budgets.push(rest[0] as number)
        return new Promise((resolve, reject) => {
          setTimeout(resolve, 6000, { postData: command.hookId })
          setTimeout(() => reject(new Error('注入处理超时')), rest[0] as number)
        })
      })
      f.client.emit('Fetch.requestPaused', f.event)
      await vi.advanceTimersByTimeAsync(10001)
      expect(budgets).toEqual([10000, 4000])
      expect(f.complete()).toEqual([['Fetch.continueRequest', expect.objectContaining({ postData: undefined })]])
      expect(f.injection.disable).toHaveBeenCalledWith('script-1', expect.stringContaining('超时'))
      await vi.advanceTimersByTimeAsync(6000)
      expect(f.complete()).toHaveLength(1)
    } finally { vi.useRealTimers(); await f.interception.stop() }
  })
  it('特殊正文与超限跳过，普通 JSON 可改写', () => {
    for (const [request, status, headers] of [
      [{ ...original, method: 'HEAD' }, 200, jsonHeaders], [original, 204, jsonHeaders], [original, 302, jsonHeaders],
      [original, 200, [{ name: 'content-type', value: 'text/event-stream' }]],
      [original, 200, [{ name: 'content-type', value: 'application/octet-stream' }]],
      [original, 200, [...jsonHeaders, { name: 'content-length', value: String(MAX_RESPONSE_BYTES + 1) }]],
      [{ ...original, resourceType: 'WebSocket' }, 200, jsonHeaders]
    ] as const) expect(responseSkipReason(request, status, [...headers])).toBeTruthy()
    expect(responseSkipReason(original, 200, jsonHeaders)).toBeUndefined()
    expect(bodyHeaders(jsonHeaders, '中文').find((h) => h.name === 'Content-Length')?.value).toBe('6')
  })
})
