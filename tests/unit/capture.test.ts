import type { CaptureSpawn } from '../../src/main/capture/service'
import type { CaptureProcessRequest, CaptureRequest, CaptureSource } from '../../src/shared/capture'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../../src/main/browser/manager'
import { captureArguments, captureOptions } from '../../src/main/browser/options'
import { CaptureAccess } from '../../src/main/capture/access'
import { CaptureEngine } from '../../src/main/capture/engine-adapter'
import { CaptureGateway } from '../../src/main/capture/gateway'
import { CaptureService } from '../../src/main/capture/service'
import { TOOLS } from '../../src/main/mcp/tools'
import { createCaptureClient } from '../../src/main/scripts/capture-client'
import { ScriptRunner } from '../../src/main/scripts/runner'
import { ScriptLogStore, ScriptStore } from '../../src/main/scripts/store'
import { ProxyVault } from '../../src/main/storage/proxy-vault'
import { ConfigStore, CookieVault } from '../../src/main/storage/store'
import { captureSettingsSchema } from '../../src/shared/capture'
import { commandSchema, configSchema, siteSchema } from '../../src/shared/model'
import { exportScript, importScript, scriptDraftSchema } from '../../src/shared/scripts'

const lanAddress = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address

class Child extends EventEmitter {
  commands: CaptureProcessRequest[] = []
  silence = new Set<string>()
  failure?: string
  pid = undefined
  postMessage(command: CaptureProcessRequest) {
    this.commands.push(command)
    if (this.silence.has(command.op)) return
    queueMicrotask(() => {
      if (this.failure) { this.emit('message', { type: 'reply', id: command.id, ok: false, error: this.failure }); return }
      const value = command.op === 'start' ? { port: command.settings.port, uiPort: 49000, username: 'private-user', password: 'private-password', spki: 'fixture-spki', fingerprint: 'fixture-fingerprint' }
        : command.op === 'acquire' ? { sourceId: command.source.id, port: 49001, spki: 'fixture-spki', fingerprint: 'fixture-fingerprint' } : undefined
      this.emit('message', { type: 'reply', id: command.id, ok: true, value })
      if (command.op === 'stop') this.emit('exit', 0)
    })
  }
  kill() { this.emit('exit', 0); return true }
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'octo-capture-'))
  const config = new ConfigStore(directory); await config.initialize()
  const encryption = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (data: Buffer) => data.toString() }
  const vault = new ProxyVault(directory, encryption, 'capture'), children: Child[] = []
  const spawn = vi.fn(async () => { const child = new Child(); children.push(child); return child as unknown as Awaited<ReturnType<CaptureSpawn>> })
  const service = new CaptureService(config, vault, vi.fn(), spawn)
  const manager = new BrowserManager(config, new CookieVault(directory, encryption), '', vi.fn(), vi.fn(), new ProxyVault(directory, encryption))
  manager.captureService = service
  const site = siteSchema.parse({ id: randomUUID(), name: '抓包网站', url: 'https://example.com', order: 0, createdAt: '', updatedAt: '', captureEnabled: true, browserOptions: { proxy: { server: 'http://proxy.example:8080', bypass: ['*.internal', '<local>'] } } })
  return { directory, config, vault, children, spawn, service, manager, site, close: async () => { await manager.shutdown(); await service.shutdown() } }
}

describe('抓包入口真实地址校验', () => {
  it.skipIf(!lanAddress)('LAN 未授权拒绝且伪造 Header 无效，白名单连接绑定可信来源', async () => {
    const registry = new Map<number, CaptureSource>(), seen: CaptureSource[] = []
    const source = { id: 'trusted', siteId: randomUUID(), name: '可信入口' }
    const engine = createServer((socket) => socket.once('data', () => {
      seen.push(registry.get(socket.remotePort!)!)
      socket.end('accepted')
    }))
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve))
    const enginePort = (engine.address() as { port: number }).port
    const denied = new CaptureGateway(enginePort, source, registry, ['192.0.2.1'])
    const allowed = new CaptureGateway(enginePort, source, registry, [lanAddress!])
    const send = (port: number) => new Promise<string>((resolve, reject) => {
      const socket = connect({ host: lanAddress!, port }, () => socket.write('GET / HTTP/1.1\r\nX-Forwarded-For: 127.0.0.1\r\nX-Octo-Capture-Source: forged\r\n\r\n'))
      let result = ''
      socket.on('data', (data) => { result += data }); socket.on('close', () => resolve(result))
      socket.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error) })
      socket.setTimeout(2000, () => socket.destroy(new Error('入口测试超时')))
    })
    try {
      await denied.listen(0, true); await allowed.listen(0, true)
      expect(await send(denied.port)).toBe('')
      expect(seen).toEqual([])
      expect(await send(allowed.port)).toBe('accepted')
      expect(seen).toEqual([source])
      await vi.waitFor(() => expect(registry.size).toBe(0))
    } finally { await denied.close(); await allowed.close(); await new Promise<void>((resolve) => engine.close(() => resolve())) }
  })
})

describe('抓包配置与生命周期', () => {
  it('旧配置默认关闭、严格端口和 IP 校验；局部网站更新保留抓包开关', async () => {
    const f = await fixture()
    try {
      const { capture: _capture, ...legacy } = f.config.get()
      expect(configSchema.parse(legacy).capture.settings).toMatchObject({ port: 8899, autoStart: false, https: true, lan: false, allowMcp: false, allowScripts: false })
      for (const port of [0, 1023, 65536, 8899.1]) expect(captureSettingsSchema.safeParse({ port }).success).toBe(false)
      for (const ip of ['999.1.2.3', 'abc', '192.168.1.1/24', 'example.com']) expect(captureSettingsSchema.safeParse({ allowedIps: [ip] }).success).toBe(false)
      expect(captureSettingsSchema.safeParse({ allowedIps: ['::1', '192.168.1.2'] }).success).toBe(true)
      await expect(f.service.save({ lan: true })).rejects.toThrow('客户端 IP')
      const id = await f.manager.saveSite(undefined, { name: '保存', url: f.site.url, captureEnabled: true })
      const command = commandSchema.parse({ type: 'site.save', id, draft: { name: '改名', url: f.site.url } })
      if (command.type !== 'site.save') throw new Error('测试命令解析失败')
      await f.manager.saveSite(id, command.draft)
      await TOOLS.find((tool) => tool.name === 'save_site')!.run(f.manager, { site_id: id, name: 'MCP 改名', url: f.site.url })
      expect(f.config.site(id).captureEnabled).toBe(true)
    } finally { await f.close() }
  })
  it('并发启动仅创建一个子进程，状态不暴露管理口令，保存不更改当前运行配置', async () => {
    const f = await fixture()
    try {
      await Promise.all([f.service.start(), f.service.start()])
      expect(f.spawn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(f.service.state())).not.toMatch(/private-user|private-password|49000/)
      await f.service.save({ port: 8990 })
      expect(f.service.state()).toMatchObject({ status: 'running', port: 8899, pending: true })
      await f.service.restart()
      expect(f.service.state()).toMatchObject({ status: 'running', port: 8990, pending: false })
      await f.service.save({ port: 8990, autoStart: true, allowMcp: true })
      expect(f.service.state().pending).toBe(false)
    } finally { await f.close() }
  })
  it('网站租约阻止启停，外部上游和网站出口独立，浏览器不接收原凭据', async () => {
    const f = await fixture()
    try {
      await expect(f.service.acquire(f.site, randomUUID())).rejects.toThrow('未运行')
      await f.service.start()
      const credentials = { username: 'upstream-user', password: 'upstream-password' }
      const lease = await f.service.acquire(f.site, randomUUID(), credentials)
      expect(f.children[0].commands.at(-1)).toMatchObject({ op: 'acquire', upstream: f.site.browserOptions.proxy, credentials })
      expect(f.service.state().sites).toEqual([f.site.id])
      await expect(f.service.stop()).rejects.toThrow('关联网站')
      await expect(f.service.restart()).rejects.toThrow('关联网站')
      const effective = captureOptions(f.site.browserOptions, lease)
      expect(effective.proxy).toEqual({ server: 'http://127.0.0.1:49001', bypass: ['*.internal', '<local>'] })
      expect(effective.acceptInsecureCerts).toBe(false)
      expect(captureArguments(lease)).toEqual(['--disable-quic', '--ignore-certificate-errors-spki-list=fixture-spki'])
      expect(f.site.browserOptions.proxy?.server).toBe('http://proxy.example:8080')
      await f.service.release(lease); await f.service.release(lease)
      expect(f.children[0].commands.filter((cmd) => cmd.op === 'release')).toHaveLength(1)
      await f.service.stop()
      expect(f.service.state().status).toBe('stopped')
    } finally { await f.close() }
  })
  it('确认停止关联网站期间拒绝新租约，但不阻塞旧租约释放', async () => {
    const f = await fixture()
    try {
      await f.service.start()
      const lease = await f.service.acquire(f.site, randomUUID())
      await f.service.stopWithSites(true, async (ids) => {
        expect(ids).toEqual([f.site.id])
        await expect(f.service.acquire(f.site, randomUUID())).rejects.toThrow('正在停止')
        await f.service.release(lease)
      })
      expect(f.service.state().status).toBe('running')
      expect(f.service.isLeaseActive(lease)).toBe(false)
    } finally { await f.close() }
  })
  it('崩溃拒绝在途请求并保留依赖，必须停止旧网站后恢复', async () => {
    const f = await fixture()
    try {
      await f.service.start()
      const lease = await f.service.acquire(f.site, randomUUID()), unavailable = vi.fn()
      f.service.onUnavailable = unavailable
      f.children[0].silence.add('query')
      const pending = f.service.query({})
      f.children[0].emit('exit', 1)
      await expect(pending).rejects.toThrow('已退出')
      expect(f.service.state()).toMatchObject({ status: 'error', sites: [f.site.id] })
      expect(unavailable).toHaveBeenCalledWith([f.site.id])
      await expect(f.service.start()).rejects.toThrow('受影响')
      await f.service.release(lease); await f.service.start()
      expect(f.service.isLeaseActive(lease)).toBe(false)
    } finally { await f.close() }
  })
  it('启动超时回收子进程，失败后可以重试', async () => {
    const f = await fixture()
    f.spawn.mockImplementationOnce(async () => { const child = new Child(); child.silence.add('start'); f.children.push(child); return child as unknown as Awaited<ReturnType<CaptureSpawn>> })
    try {
      vi.useFakeTimers()
      const starting = f.service.start()
      const assertion = expect(starting).rejects.toThrow('超时')
      await vi.waitFor(() => expect(f.children[0]?.commands).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(31000)
      await assertion
      expect(f.service.state().status).toBe('error')
      vi.useRealTimers()
      await f.service.start()
      expect(f.service.state().status).toBe('running')
    } finally { vi.useRealTimers(); await f.close() }
  })
  it('外部凭据独立保存，运行与备份引用保留；失败写入不改变配置', async () => {
    const f = await fixture()
    try {
      const settings = { upstream: { server: 'http://proxy.example:8080' } }
      await f.service.save(settings, { username: 'external', password: 'password' })
      const reference = f.config.get().capture.credentialId!
      expect(await readdir(path.join(f.directory, 'capture-proxy-credentials'))).toEqual([`${reference}.enc`])
      expect(await readFile(f.config.file, 'utf8')).not.toContain('password')
      await f.service.start()
      await f.service.save(settings, { username: 'new', password: 'new-password' })
      await f.service.save(settings)
      expect((await f.vault.read(reference)).username).toBe('external')
      const previous = f.config.get()
      const write = vi.spyOn(f.config, 'update').mockRejectedValueOnce(new Error('磁盘不可用'))
      await expect(f.service.save(settings, { username: 'bad', password: 'bad-password' })).rejects.toThrow('磁盘不可用')
      expect(f.config.get()).toEqual(previous); write.mockRestore()
      await f.service.stop()
      await expect(f.vault.read(reference)).rejects.toThrow('代理凭据')
    } finally { await f.close() }
  })
})

describe('抓包自动化访问约束', () => {
  it('总开关、逐脚本授权、来源绑定及控制权限互相独立', async () => {
    const f = await fixture(), scriptId = randomUUID(), access = new CaptureAccess(f.config, f.service)
    const source = { kind: 'action' as const, scriptId, siteId: f.site.id }
    const dispatch = (op: string, payload?: unknown) => access.dispatch(op, payload, source, () => true)
    try {
      await expect(dispatch('status')).rejects.toThrow('开启脚本')
      await f.service.save({ allowScripts: true })
      await expect(dispatch('status')).rejects.toThrow('授权')
      await f.service.grant(scriptId, 'read')
      expect(await dispatch('status')).toEqual({ status: 'stopped', port: 8899, pending: false })
      await expect(dispatch('start')).rejects.toThrow('授权')
      await expect(dispatch('stop')).rejects.toThrow('授权')
      const query = vi.spyOn(f.service, 'query').mockResolvedValue({ items: [], generation: 'test' })
      const get = vi.spyOn(f.service, 'detail').mockRejectedValue(new Error('记录不存在'))
      await dispatch('query', { url: 'test' })
      expect(query).toHaveBeenLastCalledWith({ url: 'test', siteId: f.site.id, limit: 50 })
      await expect(dispatch('query', { siteId: randomUUID() })).rejects.toThrow('当前网站')
      await expect(dispatch('query', { external: true })).rejects.toThrow('当前网站')
      await expect(dispatch('get', 'record')).rejects.toThrow('记录不存在')
      expect(get).toHaveBeenLastCalledWith('record', f.site.id)
      await access.dispatch('query', { external: true }, { kind: 'sandbox', scriptId }, () => true)
      expect(query).toHaveBeenLastCalledWith({ external: true, limit: 50 })
      await expect(access.dispatch('query', {}, { kind: 'injection', scriptId }, () => true)).rejects.toThrow('可信网站')
      await f.service.grant(scriptId, 'control'); await dispatch('start'); await dispatch('stop')
    } finally { await f.close() }
  })
  it('在途结果返回前重查授权和活跃状态；不同标签共用限额', async () => {
    const f = await fixture(), scriptId = randomUUID(), access = new CaptureAccess(f.config, f.service)
    const source = { kind: 'sandbox' as const, scriptId }
    try {
      await f.service.save({ allowScripts: true }); await f.service.grant(scriptId, 'read')
      let resolve!: (value: { items: []; generation: string }) => void
      const query = vi.spyOn(f.service, 'query').mockImplementation(() => new Promise((done) => { resolve = done }))
      const pending = access.dispatch('query', {}, source, () => true)
      await f.service.grant(scriptId, 'none'); resolve({ items: [], generation: 'test' })
      await expect(pending).rejects.toThrow('授权')
      await f.service.grant(scriptId, 'read')
      let active = true
      const stopped = access.dispatch('query', {}, source, () => active)
      active = false; resolve({ items: [], generation: 'test' })
      await expect(stopped).rejects.toThrow('停止')
      query.mockRestore()
      for (let i = 0; i < 118; i++) await access.dispatch('status', undefined, { kind: i % 2 ? 'action' : 'injection', scriptId, siteId: randomUUID() }, () => true)
      await expect(access.dispatch('status', undefined, source, () => true)).rejects.toThrow('120')
    } finally { await f.close() }
  })
  it('队列执行前拒绝已超时或已停止的控制请求', async () => {
    const f = await fixture(), scriptId = randomUUID(), access = new CaptureAccess(f.config, f.service)
    try {
      await f.service.save({ allowScripts: true }); await f.service.grant(scriptId, 'control')
      let resume!: () => void, executed = false
      vi.spyOn(f.service, 'start').mockImplementation(async (authorize) => {
        await new Promise<void>((resolve) => { resume = resolve })
        authorize?.(); executed = true
      })
      vi.useFakeTimers()
      const pending = access.dispatch('start', undefined, { kind: 'sandbox', scriptId }, () => true)
      vi.setSystemTime(Date.now() + 15001); resume()
      await expect(pending).rejects.toThrow('超时')
      expect(executed).toBe(false)
      let active = true
      const stopped = access.dispatch('start', undefined, { kind: 'sandbox', scriptId }, () => active)
      active = false; resume()
      await expect(stopped).rejects.toThrow('停止')
      expect(executed).toBe(false)
    } finally { vi.useRealTimers(); await f.close() }
  })
  it('客户端配对应答、传输错误、超时、停止、迟到应答与限流', async () => {
    vi.useFakeTimers()
    const messages: CaptureRequest[] = [], client = createCaptureClient((message) => { messages.push(message) })
    try {
      const one = client.capture.status(), two = client.capture.query()
      expect(messages[0].deadline).toBe(Date.now() + 15000)
      client.settle({ type: 'captureReply', id: messages[1].id, ok: false, error: '无权限' })
      client.settle({ type: 'captureReply', id: messages[0].id, ok: true, value: 'status' })
      expect(await one).toBe('status'); await expect(two).rejects.toThrow('无权限')
      const expired = client.capture.get('test'), assertion = expect(expired).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(15000); await assertion
      expect(client.settle({ type: 'captureReply', id: messages[2].id, ok: true, value: 'late' })).toBe(false)
      const cancelled = client.capture.status(); client.close()
      await expect(cancelled).rejects.toThrow('取消'); await expect(client.capture.start()).rejects.toThrow('停止')
      expect(vi.getTimerCount()).toBe(0)
      const broken = createCaptureClient(() => { throw new Error('通道关闭') })
      await expect(broken.capture.status()).rejects.toThrow('通道关闭')
      expect(vi.getTimerCount()).toBe(0)
      const flood = createCaptureClient((request) => flood.settle({ type: 'captureReply', id: request.id, ok: true, value: {} }))
      for (let i = 0; i < 120; i++) await flood.capture.status()
      await expect(flood.capture.status()).rejects.toThrow('120')
      await vi.advanceTimersByTimeAsync(60000); await flood.capture.status(); flood.close()
    } finally { client.close(); vi.useRealTimers() }
  })
  it('MCP 低权限仅非敏感状态，开关拒绝数据和控制，返回前再授权', async () => {
    const f = await fixture()
    const tool = (name: string) => TOOLS.find((item) => item.name === name)!
    try {
      expect(tool('capture_status').level).toBe('read')
      const status = (await tool('capture_status').run(f.manager, {}))[0]
      if (status.type !== 'text') throw new Error('抓包状态类型错误')
      expect(JSON.parse(status.text)).toEqual({ status: 'stopped', port: 8899, pending: false, allowed: false })
      for (const name of ['capture_requests', 'capture_detail', 'capture_start', 'capture_stop']) {
        expect(tool(name).level).toBe('full')
        await expect(tool(name).run(f.manager, name === 'capture_detail' ? { id: 'test' } : {})).rejects.toThrow('开启')
      }
      await f.service.save({ allowMcp: true })
      await tool('capture_start').run(f.manager, {})
      const lease = await f.service.acquire(f.site, randomUUID())
      await expect(tool('capture_stop').run(f.manager, {})).rejects.toThrow('关联网站')
      await f.service.release(lease)
      vi.spyOn(f.service, 'query').mockImplementation(async () => { await f.service.save({ allowMcp: false }); return { items: [], generation: 'test' } })
      await expect(tool('capture_requests').run(f.manager, {})).rejects.toThrow('开启')
    } finally { await f.close() }
  })
  it('新建、导入、复制不传播授权，改变类型和删除清除本机授权', async () => {
    const f = await fixture(), store = new ScriptStore(f.directory), logs = new ScriptLogStore(f.directory)
    await store.initialize()
    const runner = new ScriptRunner(store, logs, f.manager, vi.fn())
    try {
      const draft = scriptDraftSchema.parse({ name: '测试授权', match: ['example.com'], source: 'return 1' })
      const original = await runner.save(undefined, draft, 'manual')
      await f.service.grant(original.id, 'control')
      const copy = await runner.save(undefined, original.draft, 'manual')
      const imported = await runner.save(undefined, importScript(exportScript(original.draft)), 'import')
      expect(f.config.get().capture.grants[copy.id]).toBeUndefined()
      expect(f.config.get().capture.grants[imported.id]).toBeUndefined()
      await runner.save(original.id, { ...draft, kind: 'sandbox', dependencies: [], match: [], sandbox: { mode: 'once' } }, 'manual')
      expect(f.config.get().capture.grants[original.id]).toBeUndefined()
      await f.service.grant(original.id, 'read'); await runner.remove(original.id)
      expect(f.config.get().capture.grants[original.id]).toBeUndefined()
    } finally { await runner.shutdown(); await f.close() }
  })
})

function queryFixture() {
  const generation = randomUUID(), engine = new CaptureEngine(generation)
  const records = new Map<string, Record<string, unknown>>(), metadata = new Map<string, CaptureSource>()
  Object.assign(engine, { proxy: { getItem: (id: string) => records.get(id) }, metadata })
  const add = (id: string, overrides: Record<string, unknown> = {}, source: CaptureSource = { id: 'external', name: '外部' }) => {
    records.set(id, { id, url: 'https://example.com/test', startTime: 1, requestTime: 2, endTime: 3, req: { method: 'GET', size: 0 }, res: { statusCode: 200, size: 0 }, ...overrides })
    metadata.set(id, source)
    return `${generation}:${id}`
  }
  return { engine, generation, records, add }
}
describe('有界查询与正文语义', () => {
  it('分页、组合过滤、旧代次、非法游标、淘汰、清空与计数同步', () => {
    const f = queryFixture(), source = { id: randomUUID(), siteId: randomUUID(), name: '本站' }
    f.add('1-10'); const first = f.add('1-2', {}, source); f.add('1-3', { startTime: 10 }, source)
    expect(f.engine.query({ limit: 1 }).items[0].id).toBe(first)
    expect(f.engine.query({ cursor: first, siteId: source.siteId, method: 'get', status: 200, url: 'EXAMPLE', from: 9, to: 11 }).items.map((r) => r.id)).toEqual([`${f.generation}:1-3`])
    expect(f.engine.query({ external: true }).items).toHaveLength(1)
    expect(f.engine.query({ to: 0 }).items).toHaveLength(0)
    expect(() => f.engine.query({ from: 10, to: 1 })).toThrow('时间')
    expect(() => f.engine.query({ cursor: `${randomUUID()}:1-2` })).toThrow('过期')
    expect(() => f.engine.query({ cursor: `${f.generation}:fake` })).toThrow('游标')
    expect(() => f.engine.detail(first, randomUUID())).toThrow('无权')
    f.records.delete('1-2')
    expect(() => f.engine.query({ cursor: first })).toThrow('淘汰')
    expect(f.engine.count()).toBe(2)
    f.records.clear(); expect(f.engine.count()).toBe(0)
    expect(() => f.engine.detail(first)).toThrow('不存在')
  })
  it('保留重复 Header，过滤内部头；压缩体使用解压长度、不误报截断', () => {
    const f = queryFixture(), bytes = Buffer.from('压缩正文')
    const id = f.add('1-1', { res: { statusCode: 200, size: 40, unzipSize: bytes.length, base64: bytes.toString('base64'), headers: { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip', 'set-cookie': ['a=1', 'b=2'], 'Proxy-Authorization': 'private', 'X-Whistle-Test': 'private' } } })
    const result = f.engine.detail(id)
    expect(result.response.body).toMatchObject({ text: '压缩正文', contentEncoding: 'gzip', decoded: true, size: bytes.length, wireSize: 40, truncated: false, unavailable: false, pending: false })
    expect(result.response.headers.filter((h) => h.name === 'set-cookie').map((h) => h.value)).toEqual(['a=1', 'b=2'])
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('缺失、真正空正文、传输中、未知编码和二进制不混淆', () => {
    const f = queryFixture()
    const read = (res: object, extra: object = {}) => f.engine.detail(f.add('1-1', { res, ...extra })).response.body
    expect(read({ body: '', size: 2000000 })).toMatchObject({ unavailable: true, truncated: true })
    expect(read({ body: '', size: 0 })).toMatchObject({ base64: '', unavailable: false, truncated: false })
    expect(read({ body: Buffer.alloc(0), size: 20, unzipSize: 0, headers: { 'content-encoding': 'gzip' } })).toMatchObject({ base64: '', size: 0, unavailable: false, truncated: false })
    expect(read({ size: 0 }, { endTime: undefined })).toMatchObject({ pending: true, unavailable: true, truncated: true })
    expect(read({ body: Buffer.from('partial'), size: 7 }, { endTime: undefined })).toMatchObject({ base64: Buffer.from('partial').toString('base64'), unavailable: false, truncated: true })
    const encoded = { body: Buffer.from([0xFF, 0x00]), size: 2, headers: { 'content-type': 'text/plain; charset=unknown-charset' } }
    expect(read(encoded)).toMatchObject({ base64: '/wA=', encoding: 'unknown-charset' })
    expect(read({ ...encoded, headers: { 'content-type': 'text/plain', 'content-encoding': 'zstd' } })).toMatchObject({ base64: '/wA=', decoded: false, contentEncoding: 'zstd' })
    expect(read({ body: Buffer.from([0xE9]), size: 1, headers: { 'content-type': 'text/plain; charset=iso-8859-1' } })).toMatchObject({ text: 'é', encoding: 'iso-8859-1' })
    expect(read({ body: 'Error: decompression failed', size: 20 })).toMatchObject({ unavailable: true })
  })
  it('正文限制 1 MiB，并保持多字节文本截断边界', () => {
    const f = queryFixture(), body = Buffer.from('中'.repeat(400000))
    const result = f.engine.detail(f.add('1-1', { res: { body, size: body.length, headers: { 'content-type': 'text/plain' } } })).response.body
    expect(result.truncated).toBe(true); expect(result.unavailable).toBe(false)
    expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(1048576)
    expect(result.text).not.toContain('�')
  })
})
