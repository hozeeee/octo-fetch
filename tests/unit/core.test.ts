import type { Page } from 'puppeteer-core'
import type { BrowserManager } from '../../src/main/browser/manager'
import type { Content } from '../../src/main/mcp/tools'
import type { Encryptor } from '../../src/main/storage/store'
import type { Cookie, Frame } from '../../src/shared/model'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LatestFrameMailbox, PageStream } from '../../src/main/browser/stream'
import { McpService } from '../../src/main/mcp/server'
import { permits, TokenRegistry } from '../../src/main/mcp/tokens'
import { TOOLS } from '../../src/main/mcp/tools'
import { ConfigStore, CookieVault, SecretVault, SerialQueue } from '../../src/main/storage/store'
import { browserOptionsSchema } from '../../src/shared/browser-options'
import { cookieKey, diffCookies, mergeCookies, parseCookieText, validateCookies } from '../../src/shared/cookies'
import { mapPoint } from '../../src/shared/coordinates'
import { commandSchema, cookieSchema, DEFAULT_SETTINGS, MCP_LEVELS, settingsSchema, urlSchema } from '../../src/shared/model'

const cookie: Cookie = { name: 'session', value: 'fixture-value', domain: 'example.com', path: '/', secure: true }
const text = (content: Content[]): string => content.map((item) => item.type === 'text' ? item.text : `[${item.mimeType}]`).join('\n')
function keyring(): Encryptor {
  const key = randomBytes(32)
  return {
    async encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    async decrypt(data) { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8') }
  }
}

describe('输入与 Cookie', () => {
  it.each(['file:///tmp/private', 'javascript:alert(1)', 'https://user:pass@example.com', 'data:text/html,a', 'invalid'])('拒绝不安全 URL %s', (url) => { expect(urlSchema.safeParse(url).success).toBe(false) })
  it('允许正常网址和本地 HTTP 测试站', () => {
    expect(urlSchema.safeParse('https://example.com/a?q=1').success).toBe(true)
    expect(urlSchema.safeParse('http://127.0.0.1:8080/').success).toBe(true)
  })
  it('字符串保留等号及编码，并且绑定主机', () => {
    const parsed = parseCookieText('session=a=b==; encoded=%2F; empty=', 'header', 'https://example.com/path')
    expect(parsed.cookies.map((item) => item.value)).toEqual(['a=b==', '%2F', ''])
    expect(parsed.cookies[0]).toMatchObject({ domain: 'example.com', path: '/', secure: true })
    expect(parsed.warnings.length).toBe(1)
  })
  it('转换浏览器 JSON 元数据，保留分区', () => {
    const parsed = parseCookieText(JSON.stringify([{ ...cookie, hostOnly: false, session: true, size: 10, expirationDate: 1, sameSite: 'lax', partitionKey: { sourceOrigin: 'https://example.org', hasCrossSiteAncestor: true } }]), 'json', 'https://example.com')
    expect(parsed.cookies[0]).toMatchObject({ domain: '.example.com', sameSite: 'Lax', partitionKey: { hasCrossSiteAncestor: true } })
    expect(parsed.cookies[0].expires).toBeUndefined()
    expect(parsed.warnings.length).toBeGreaterThan(0)
  })
  it('不静默丢弃未知或已移除的属性', () => {
    expect(() => parseCookieText(JSON.stringify([{ ...cookie, custom: true }]), 'json', 'https://example.com')).toThrow('不支持的属性')
    expect(() => parseCookieText(JSON.stringify([{ ...cookie, sameParty: true }]), 'json', 'https://example.com')).toThrow('不支持的属性')
  })
  it('校验过期、重复及安全前缀', () => {
    expect(() => validateCookies([{ ...cookie, expires: 1 }])).toThrow('已过期')
    expect(() => validateCookies([cookie, cookie])).toThrow('重复')
    expect(cookieSchema.safeParse({ ...cookie, sameSite: 'None', secure: false }).success).toBe(false)
    expect(cookieSchema.safeParse({ ...cookie, name: '__Host-session', domain: '.example.com' }).success).toBe(false)
    expect(cookieSchema.safeParse({ ...cookie, name: 'bad\nname' }).success).toBe(false)
  })
  it('合并保留其他域，删除操作只影响完整键', () => {
    const other = { ...cookie, domain: 'other.test' }
    const partitioned = { ...cookie, partitionKey: 'https://example.org' }
    const next = mergeCookies([cookie, other, partitioned], { remove: [cookie], upsert: [{ ...other, value: 'changed' }] })
    expect(next).toHaveLength(2)
    expect(next.find((item) => item.domain === 'other.test')?.value).toBe('changed')
    expect(cookieKey(partitioned)).not.toBe(cookieKey(cookie))
    expect(diffCookies([cookie, other], [other])).toEqual({ remove: [cookie], upsert: [] })
  })
  it.each([1, 4, 5, 100, Number.MAX_SAFE_INTEGER])('IPC 允许网站运行数量 %s，不设业务上限', (maxRunning) => {
    const command = { type: 'settings.save', settings: { ...DEFAULT_SETTINGS, maxRunning } }
    expect(commandSchema.parse(command)).toEqual(command)
  })
  it.each([0, -1, 1.5, Infinity, NaN, null, '5'])('IPC 拒绝非法网站运行数量 %s', (maxRunning) => {
    expect(commandSchema.safeParse({ type: 'settings.save', settings: { ...DEFAULT_SETTINGS, maxRunning } }).success).toBe(false)
  })
  it('全局默认 UA 兼容缺省值、去除首尾空格并接受长度边界', () => {
    const { defaultUserAgent: _ua, ...legacy } = DEFAULT_SETTINGS
    expect(settingsSchema.parse(legacy).defaultUserAgent).toBe('')
    expect(settingsSchema.parse({ ...legacy, defaultUserAgent: '  OctoDefault/1.0  ' }).defaultUserAgent).toBe('OctoDefault/1.0')
    expect(settingsSchema.parse({ ...legacy, defaultUserAgent: '   ' }).defaultUserAgent).toBe('')
    expect(settingsSchema.parse({ ...legacy, defaultUserAgent: 'a'.repeat(4096) }).defaultUserAgent).toHaveLength(4096)
  })
  it.each(['ua\nheader: injected', 'ua\r', 'ua\t', 'ua\u0000', 'ua\u007F', 'ua\u0085', 'a'.repeat(4097), null, 123])('IPC 拒绝无效全局默认 UA %#', (defaultUserAgent) => {
    expect(commandSchema.safeParse({ type: 'settings.save', settings: { ...DEFAULT_SETTINGS, defaultUserAgent } }).success).toBe(false)
  })
  it('沙箱 Registry 兼容旧配置并拒绝凭据和非 HTTP 协议', () => {
    const { sandboxRegistry: _registry, ...legacy } = DEFAULT_SETTINGS
    expect(settingsSchema.parse(legacy).sandboxRegistry).toBe(DEFAULT_SETTINGS.sandboxRegistry)
    expect(settingsSchema.parse({ ...legacy, sandboxRegistry: ' https://registry.example.com/npm/ ' }).sandboxRegistry).toBe('https://registry.example.com/npm/')
    for (const sandboxRegistry of ['file:///tmp/registry', 'https://user:secret@example.com/', 'not-a-url']) {
      expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, sandboxRegistry }).success).toBe(false)
    }
  })
  it('IPC 拒绝错误 target 和不在范围内的输入', () => {
    expect(commandSchema.safeParse({ type: 'input', siteId: randomUUID(), generation: randomUUID(), tabId: randomUUID(), input: { type: 'move', x: -1, y: 0 } }).success).toBe(false)
    expect(commandSchema.safeParse({ type: 'execute', script: 'arbitrary' }).success).toBe(false)
  })
})

describe('坐标、背压和清理', () => {
  it('缩放映射排除留白，拖动可夹紧', () => {
    const rect = { left: 10, top: 20, width: 640, height: 500 }
    expect(mapPoint(rect, 330, 270)).toEqual({ x: 640, y: 400 })
    expect(mapPoint(rect, 20, 25)).toBeNull()
    expect(mapPoint(rect, 10000, 10000, true)).toEqual({ x: 1279, y: 799 })
    expect(mapPoint({ ...rect, width: 0 }, 0, 0)).toBeNull()
  })
  it('每个流最多保留一帧发送中和一帧待发送', () => {
    const box = new LatestFrameMailbox()
    const frame: Frame = { siteId: randomUUID(), generation: randomUUID(), tabId: randomUUID(), sequence: 1, data: 'fixture' }
    box.offer(frame); expect(box.take()).toEqual(frame)
    for (let i = 2; i < 100; i++) box.offer({ ...frame, sequence: i })
    expect(box.take()).toBeUndefined()
    box.acknowledge({ ...frame, generation: randomUUID() }); expect(box.take()).toBeUndefined()
    box.acknowledge(frame); expect(box.take()?.sequence).toBe(99)
    box.clear(); expect(box.take()).toBeUndefined()
  })
  it('截屏流失败时降级，并在停止后不再截屏', async () => {
    vi.useFakeTimers()
    const screenshot = vi.fn().mockResolvedValue('fixture-frame')
    const session = { send: vi.fn().mockResolvedValue({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800, offsetX: 0, offsetY: 0, scale: 1 } }), detach: vi.fn() }
    const page = { createCDPSession: vi.fn().mockRejectedValueOnce(new Error('unsupported')).mockResolvedValue(session), isClosed: () => false, screenshot } as unknown as Page
    const send = vi.fn()
    const mode = vi.fn()
    const stream = new PageStream(page, { siteId: randomUUID(), generation: randomUUID(), tabId: randomUUID() }, () => ({ fps: 15, quality: 70 }), () => 1, send, mode)
    try {
      await stream.start(); await vi.advanceTimersByTimeAsync(1000)
      expect(mode).toHaveBeenCalledWith('fallback')
      expect(screenshot.mock.calls.length).toBeLessThanOrEqual(6)
      expect(send).toHaveBeenCalledTimes(1)
      await stream.stop()
      const count = screenshot.mock.calls.length
      await vi.advanceTimersByTimeAsync(1000)
      expect(screenshot).toHaveBeenCalledTimes(count)
    } finally { vi.useRealTimers() }
  })
})

describe('本地存储', () => {
  it('串行任务在失败之后仍能继续', async () => {
    const queue = new SerialQueue()
    const events: number[] = []
    const first = queue.run(async () => { events.push(1); throw new Error('fixture') })
    const second = queue.run(async () => { events.push(2); return 2 })
    await expect(first).rejects.toThrow('fixture'); await expect(second).resolves.toBe(2)
    expect(events).toEqual([1, 2])
  })
  it('原子配置写入、并发合并与损坏备份恢复', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-config-'))
    const store = new ConfigStore(dir); await store.initialize()
    await Promise.all([store.update((config) => { config.settings.gridFps = 3 }), store.update((config) => { config.settings.quality = 80 })])
    expect(store.get().settings).toMatchObject({ gridFps: 3, quality: 80 })
    await writeFile(path.join(dir, 'config.json'), 'broken')
    const recovered = new ConfigStore(dir); await recovered.initialize()
    expect(recovered.get().settings).toEqual({ ...DEFAULT_SETTINGS, gridFps: 3 })
    expect(recovered.warnings).toHaveLength(1)
  })
  it('超过原上限的网站运行数量可保存并重新加载', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-settings-'))
    const store = new ConfigStore(dir); await store.initialize()
    await store.update((config) => { config.settings.maxRunning = 100 })
    const reloaded = new ConfigStore(dir); await reloaded.initialize()
    expect(reloaded.get().settings.maxRunning).toBe(100)
    expect(reloaded.warnings).toEqual([])
  })
  it('旧配置补空默认 UA，全局 UA 可保存、重载和清空', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-default-ua-'))
    const { defaultUserAgent: _ua, ...settings } = DEFAULT_SETTINGS
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ schemaVersion: 1, sites: [], settings }))
    const store = new ConfigStore(dir); await store.initialize()
    expect(store.get().settings.defaultUserAgent).toBe('')
    expect(store.warnings).toEqual([])
    await store.update((config) => { config.settings.defaultUserAgent = 'OctoDefault/1.0' })
    const reloaded = new ConfigStore(dir); await reloaded.initialize()
    expect(reloaded.get().settings.defaultUserAgent).toBe('OctoDefault/1.0')
    await reloaded.update((config) => { config.settings.defaultUserAgent = '' })
    const cleared = new ConfigStore(dir); await cleared.initialize()
    expect(cleared.get().settings.defaultUserAgent).toBe('')
  })
  it('无有效备份时不自动重置配置', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-corrupt-'))
    await writeFile(path.join(dir, 'config.json'), 'broken')
    await expect(new ConfigStore(dir).initialize()).rejects.toThrow('不会自动清空')
    expect(await readFile(path.join(dir, 'config.json'), 'utf8')).toBe('broken')
  })
  it('Cookie 密文不含原文，自动快照不覆盖待应用修改', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-vault-'))
    const vault = new CookieVault(dir, keyring())
    const id = randomUUID()
    await vault.capture(id, [cookie])
    await vault.stage(id, { upsert: [{ ...cookie, value: 'manual' }], remove: [] })
    await vault.capture(id, [{ ...cookie, value: 'website' }])
    expect((await vault.read(id)).pending?.upsert[0].value).toBe('manual')
    expect((await readFile(path.join(dir, 'cookie-vault', `${id}.enc`))).includes(Buffer.from('fixture-value'))).toBe(false)
    await vault.stage(id, { upsert: [], remove: [cookie] })
    expect((await vault.read(id)).pending).toEqual({ upsert: [], remove: [cookie] })
    await vault.capture(id, [], true)
    expect((await vault.read(id)).pending).toBeUndefined()
  })
  it('加密失败不会退回明文', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-encryption-'))
    const vault = new CookieVault(dir, { encrypt: async () => { throw new Error('钥匙串不可用') }, decrypt: async () => '' })
    await expect(vault.capture(randomUUID(), [cookie])).rejects.toThrow('钥匙串不可用')
  })
  it('与 Electron 自带的 Cookies 文件同目录也能读写快照', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-collision-'))
    // Electron 默认会在 userData 下写 Cookies 数据库；macOS 默认卷大小写不敏感。
    await writeFile(path.join(dir, 'Cookies'), 'sqlite-placeholder')
    const vault = new CookieVault(dir, { encrypt: async (text) => Buffer.from(text), decrypt: async (data) => data.toString('utf8') })
    await vault.initialize()
    const id = randomUUID()
    expect((await vault.read(id)).snapshot).toEqual([])
    await vault.capture(id, [cookie])
    expect((await vault.read(id)).snapshot).toEqual([cookie])
    expect(await readFile(path.join(dir, 'Cookies'), 'utf8')).toBe('sqlite-placeholder')
  })
})

describe('MCP 身份与工具', () => {
  async function registry() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-mcp-'))
    const store = new ConfigStore(dir); await store.initialize()
    const vault = new SecretVault(dir, keyring())
    const changed = vi.fn()
    return { dir, store, vault, changed, tokens: new TokenRegistry(store, vault, changed) }
  }
  it('权限等级向下包含，越级调用被拒绝', () => {
    expect(MCP_LEVELS.every((level) => permits(level, 'read'))).toBe(true)
    expect(permits('read', 'operate')).toBe(false)
    expect(permits('operate', 'full')).toBe(false)
    expect(permits('full', 'operate')).toBe(true)
  })
  it('工具目录名称唯一，只读等级稳定，脚本写入与执行仅限三级', () => {
    const names = TOOLS.map((item) => item.name)
    expect(new Set(names).size).toBe(names.length)
    expect(TOOLS.filter((item) => item.level === 'read').map((item) => item.name)).toEqual(['list_notification_channels', 'read_notification_logs', 'script_guide', 'list_scripts', 'read_script', 'read_script_runs', 'list_tasks', 'read_task', 'read_task_runs', 'list_data', 'read_data', 'capture_status', 'list_sites', 'list_tabs', 'read_page', 'capture_screenshot', 'get_settings'])
    expect(names.filter((name) => /token|mcp|execute|eval/.test(name))).toEqual([])
    expect(TOOLS.filter((item) => item.name.includes('script') && item.level === 'full').map((item) => item.name)).toEqual(['save_script', 'run_script', 'cancel_script_run', 'delete_script'])
    expect(TOOLS.every((item) => item.input.type === 'object' && item.input.additionalProperties === false)).toBe(true)
  })
  it('全局配置工具不声明网站数量上限，并允许保存大于 4 的值', async () => {
    const tool = TOOLS.find((item) => item.name === 'save_settings')!
    expect(tool.input).toMatchObject({ properties: { max_running: { type: 'integer', minimum: 1 } } })
    expect(tool.input).not.toHaveProperty('properties.max_running.maximum')
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    const manager = { store: { get: () => ({ settings: DEFAULT_SETTINGS }) }, saveSettings } as unknown as BrowserManager
    const settings = { ...DEFAULT_SETTINGS, maxRunning: 100 }
    expect(JSON.parse(text(await tool.run(manager, { max_running: 100 })))).toEqual(settings)
    expect(saveSettings).toHaveBeenCalledWith(settings)
    for (const max_running of [0, -1, 1.5]) await expect(tool.run(manager, { max_running })).rejects.toThrow()
    expect(saveSettings).toHaveBeenCalledTimes(1)
  })
  it('MCP 全局默认 UA 可读写，省略保留、空字符串清除且拒绝非法值', async () => {
    const tool = TOOLS.find((item) => item.name === 'save_settings')!
    expect(tool.input).toMatchObject({ properties: { default_user_agent: { type: 'string', maxLength: 4096 } } })
    let current = { ...DEFAULT_SETTINGS }
    const saveSettings = vi.fn(async (settings: typeof current) => { current = settings })
    const manager = { store: { get: () => ({ settings: current }) }, saveSettings, runningCount: () => 0 } as unknown as BrowserManager
    await tool.run(manager, { default_user_agent: '  OctoGlobal/1.0  ' })
    expect(current.defaultUserAgent).toBe('OctoGlobal/1.0')
    await tool.run(manager, { quality: 80 })
    expect(current).toMatchObject({ defaultUserAgent: 'OctoGlobal/1.0', quality: 80 })
    await tool.run(manager, { sandbox_registry: 'https://registry.example.com/' })
    expect(current.sandboxRegistry).toBe('https://registry.example.com/')
    expect(JSON.parse(text(await TOOLS.find((item) => item.name === 'get_settings')!.run(manager, {}))).defaultUserAgent).toBe('OctoGlobal/1.0')
    await tool.run(manager, { default_user_agent: '' })
    expect(current.defaultUserAgent).toBe('')
    for (const default_user_agent of ['ua\n', 'ua\u0085', 'a'.repeat(4097), null, 1]) await expect(tool.run(manager, { default_user_agent })).rejects.toThrow()
    for (const sandbox_registry of ['file:///tmp/packages', 'https://user:secret@example.com/']) await expect(tool.run(manager, { sandbox_registry })).rejects.toThrow()
    expect(saveSettings).toHaveBeenCalledTimes(4)
  })
  it('工具参数经过校验，拒绝未知字段与越界坐标', async () => {
    const siteId = randomUUID()
    const manager = {
      store: { get: () => ({ sites: [{ id: siteId, name: '示例', url: 'https://example.com', cookieCount: 2, pendingCookies: false, injections: [], browserOptions: browserOptionsSchema.parse({}) }] }) },
      states: () => []
    } as unknown as BrowserManager
    const call = (name: string, args: unknown) => TOOLS.find((item) => item.name === name)!.run(manager, args)
    expect(JSON.parse(text(await call('list_sites', {})))).toMatchObject([{ site_id: siteId, name: '示例', url: 'https://example.com', status: 'stopped', tabs: 0, cookie_count: 2, pending_cookies: false, injections: [], browser_options_pending: false, device_summary: '桌面端 · 1280 × 800 · DPR 1' }])
    await expect(call('navigate', { site_id: siteId, url: 'https://example.com', extra: 1 })).rejects.toThrow()
    await expect(call('navigate', { site_id: siteId, url: 'javascript:alert(1)' })).rejects.toThrow()
    await expect(call('click', { site_id: siteId, x: 100001, y: 0 })).rejects.toThrow()
    await expect(call('read_page', { site_id: 'not-an-id' })).rejects.toThrow()
  })
  it('身份令牌只留指纹，别名与暂停可维护', async () => {
    const { dir, vault, changed, tokens } = await registry()
    const created = await tokens.create({ alias: 'Claude Desktop', level: 'read' })
    expect(created.secret.startsWith('octo_')).toBe(true)
    expect(await readFile(path.join(dir, 'config.json'), 'utf8')).not.toContain(created.secret)
    expect((await readFile(vault.file)).includes(Buffer.from(created.secret))).toBe(false)
    expect(tokens.verify(created.secret)?.alias).toBe('Claude Desktop')
    expect(tokens.verify(`${created.secret}x`)).toBeUndefined()
    expect((await tokens.reveal(created.id)).secret).toBe(created.secret)
    await tokens.save(created.id, { alias: '本地脚本', level: 'full' })
    await tokens.enable(created.id, false)
    expect(tokens.list()[0]).toMatchObject({ alias: '本地脚本', level: 'full', enabled: false, prefix: created.secret.slice(0, 12) })
    expect(changed).toHaveBeenCalled()
    await expect(tokens.save(randomUUID(), { alias: 'x', level: 'read' })).rejects.toThrow('身份不存在')
  })
  it('调用统计攒批落盘，换发令牌作废旧令牌并保留统计', async () => {
    const { dir, vault, tokens } = await registry()
    const created = await tokens.create({ alias: '统计', level: 'operate' })
    tokens.record(created.id, 'read_page', 'ok')
    tokens.record(created.id, 'click', 'error')
    tokens.record(created.id, 'save_site', 'denied')
    expect(tokens.list()[0].calls).toBe(0)
    await tokens.flush()
    expect(tokens.list()[0]).toMatchObject({ calls: 3, errors: 1, denied: 1, lastTool: 'save_site' })
    const rotated = await tokens.rotate(created.id)
    expect(rotated.secret).not.toBe(created.secret)
    expect(tokens.verify(created.secret)).toBeUndefined()
    expect(tokens.verify(rotated.secret)).toMatchObject({ alias: '统计', calls: 3 })
    expect((await readFile(path.join(dir, 'config.json'), 'utf8')).includes(rotated.secret)).toBe(false)
    await tokens.remove(created.id)
    expect(tokens.list()).toEqual([])
    await expect(tokens.reveal(created.id)).rejects.toThrow('身份不存在')
    await expect(vault.read(created.id)).rejects.toThrow('重新生成')
  })
  it('服务只放行本应用签发的令牌，并按等级裁剪工具', async () => {
    const { store, tokens } = await registry()
    const manager = { store, states: () => [] } as unknown as BrowserManager
    const service = new McpService(manager, tokens, '0.0.0-test', vi.fn())
    const port = 41000 + Math.floor(Math.random() * 4000)
    await service.save({ enabled: true, port })
    const created = await tokens.create({ alias: '只读接入', level: 'read' })
    type Answer = { status: number; body: { result?: { serverInfo?: { name: string }; tools?: { name: string }[]; content?: Content[]; isError?: boolean }; error?: { message: string } } }
    const rpc = async (method: string, params: unknown, secret?: string): Promise<Answer> => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }
      })
      return { status: response.status, body: await response.json() as Answer['body'] }
    }
    try {
      expect(service.state()).toMatchObject({ running: true, port, endpoint: `http://127.0.0.1:${port}/mcp` })
      const handshake = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, created.secret)
      expect(handshake.status).toBe(200)
      expect(handshake.body.result?.serverInfo?.name).toBe('octo-fetch')
      expect((await rpc('tools/list', {})).status).toBe(401)
      expect((await rpc('tools/list', {}, `${created.secret}x`)).status).toBe(401)
      const listed = await rpc('tools/list', {}, created.secret)
      expect(listed.body.result?.tools?.map((item) => item.name)).toEqual(['list_notification_channels', 'read_notification_logs', 'script_guide', 'list_scripts', 'read_script', 'read_script_runs', 'list_tasks', 'read_task', 'read_task_runs', 'list_data', 'read_data', 'capture_status', 'list_sites', 'list_tabs', 'read_page', 'capture_screenshot', 'get_settings'])
      const allowed = await rpc('tools/call', { name: 'list_sites', arguments: {} }, created.secret)
      expect(allowed.body.result?.isError).toBeFalsy()
      const refused = await rpc('tools/call', { name: 'navigate', arguments: { site_id: randomUUID(), url: 'https://example.com' } }, created.secret)
      expect(refused.body.result?.isError).toBe(true)
      expect(text(refused.body.result?.content || [])).toContain('二级')
      for (const name of ['save_script', 'run_script', 'cancel_script_run', 'delete_script']) {
        const denied = await rpc('tools/call', { name, arguments: {} }, created.secret)
        expect(denied.body.result?.isError).toBe(true)
        expect(text(denied.body.result?.content || [])).toContain('三级')
      }
      await tokens.enable(created.id, false)
      const paused = await rpc('tools/list', {}, created.secret)
      expect(paused.status).toBe(403)
      expect(paused.body.error?.message).toContain('已暂停')
    } finally { await service.stop() }
    expect(tokens.list()[0]).toMatchObject({ calls: 7, denied: 6, errors: 0 })
    expect(service.state().running).toBe(false)
  })
})
