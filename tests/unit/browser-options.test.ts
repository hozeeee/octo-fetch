import type { CDPSession, Page } from 'puppeteer-core'
import type { Encryptor } from '../../src/main/storage/store'
import type { BrowserOptionsDraft } from '../../src/shared/browser-options'
import type { Frame } from '../../src/shared/model'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PageInput } from '../../src/main/browser/input'
import { matchesProxyChallenge, PageInterception } from '../../src/main/browser/interception'
import { BrowserManager } from '../../src/main/browser/manager'
import { applyPageOptions, connectionOptions, isPageCapturing, pageScreenshot, resolveOptions, validatePoint } from '../../src/main/browser/options'
import { PageStream } from '../../src/main/browser/stream'
import { TOOLS } from '../../src/main/mcp/tools'
import { ProxyVault } from '../../src/main/storage/proxy-vault'
import { ConfigStore, CookieVault } from '../../src/main/storage/store'
import { browserOptionsFingerprint, browserOptionsSchema, devicePreset, extraHeadersSchema, proxySchema } from '../../src/shared/browser-options'
import { mapPoint } from '../../src/shared/coordinates'
import { commandSchema, siteSchema } from '../../src/shared/model'

vi.mock('electron', () => ({ clipboard: { readText: vi.fn(), writeText: vi.fn() } }))
const legacy = () => ({ id: randomUUID(), name: '旧网站', url: 'https://example.com', order: 0, createdAt: '', updatedAt: '' })
function encryptor(): Encryptor {
  const key = randomBytes(32)
  return {
    async encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    async decrypt(data) { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString() }
  }
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-options-'))
  const store = new ConfigStore(dir); await store.initialize()
  const encryption = encryptor(), vault = new ProxyVault(dir, encryption)
  const manager = new BrowserManager(store, new CookieVault(dir, encryption), '', vi.fn(), vi.fn(), vault)
  return { dir, store, vault, manager }
}

describe('浏览器配置校验和兼容', () => {
  it('旧配置补桌面默认，IPC 省略不补值，显式空对象恢复默认', () => {
    expect(siteSchema.parse(legacy()).browserOptions).toEqual(browserOptionsSchema.parse({}))
    const parse = (draft: unknown) => commandSchema.parse({ type: 'site.save', draft })
    expect(parse({ name: '改名', url: 'https://example.com' })).not.toHaveProperty('draft.browserOptions')
    expect(parse({ name: '改名', url: 'https://example.com', browserOptions: {} })).toHaveProperty('draft.browserOptions.viewport.width', 1280)
  })
  it('预设默认视口、自定义 UA 优先及 Android 实际版本', () => {
    const android = browserOptionsSchema.parse({ preset: 'android' })
    expect(android.viewport).toMatchObject({ width: 393, height: 851, deviceScaleFactor: 3, hasTouch: true, isMobile: true })
    const resolved = resolveOptions(android, '155.1.2.3')
    expect(resolved.userAgent).toContain('Chrome/155.1.2.3')
    expect(resolved.userAgentMetadata?.brands?.[0].version).toBe('155')
    const custom = resolveOptions(browserOptionsSchema.parse({ preset: 'android', userAgent: 'MyBrowser/1.0' }), '155.1.2.3')
    expect(custom.userAgent).toBe('MyBrowser/1.0'); expect(custom.userAgentMetadata).toBeUndefined()
    expect(browserOptionsSchema.parse({ preset: 'iphone' }).userAgentMetadata).toBeUndefined()
    expect(devicePreset('desktop', '')).toMatchObject({ viewport: { width: 1280, isMobile: false } })
  })
  it('网站 UA 与设备预设优先，空值继承全局默认 UA 且不改写网站配置', () => {
    const defaultUA = 'OctoGlobal/1.0', version = '155.1.2.3'
    for (const draft of [{}, { userAgent: '' }, { userAgent: '   ' }, { preset: 'android' as const, userAgent: '' }]) {
      const options = browserOptionsSchema.parse(draft), before = structuredClone(options)
      const resolved = resolveOptions(options, version, defaultUA)
      expect(resolved.userAgent).toBe(defaultUA)
      expect(resolved.viewport).toEqual(options.viewport)
      expect(resolved.userAgentMetadata).toBeUndefined()
      expect(options).toEqual(before)
    }
    const custom = browserOptionsSchema.parse({ userAgent: 'Site/1.0', platform: 'CustomPlatform' })
    expect(resolveOptions(custom, version, defaultUA)).toMatchObject({ userAgent: 'Site/1.0', platform: 'CustomPlatform' })
    for (const preset of ['android', 'iphone', 'ipad'] as const) {
      expect(resolveOptions(browserOptionsSchema.parse({ preset }), version, defaultUA)).toMatchObject(devicePreset(preset, version))
    }
    expect(resolveOptions(browserOptionsSchema.parse({}), version, '').userAgent).toBeUndefined()
  })
  it('全局默认 UA 仅改变继承网站的配置指纹', () => {
    const fingerprint = (options: BrowserOptionsDraft, ua: string) => browserOptionsFingerprint(options, undefined, ua)
    expect(fingerprint({}, 'Global/1')).not.toBe(fingerprint({}, 'Global/2'))
    expect(fingerprint({ userAgent: '' }, 'Global/1')).toBe(fingerprint({}, 'Global/1'))
    expect(fingerprint({}, 'Global/1')).toBe(fingerprint({ userAgent: 'Global/1' }, 'Global/2'))
    expect(fingerprint({}, '')).toBe(browserOptionsFingerprint({}))
    for (const draft of [{ userAgent: 'Site/1' }, { preset: 'android' as const }, { preset: 'iphone' as const }, { preset: 'ipad' as const }]) {
      expect(fingerprint(draft, 'Global/1')).toBe(fingerprint(draft, 'Global/2'))
    }
  })
  it.each<BrowserOptionsDraft>([
    { userAgent: 'ua\nheader: injected' }, { platform: 'x\u0000' }, { userAgent: 'ua\u0085' }, { viewport: { width: 239 } },
    { viewport: { width: 3840, height: 3840, deviceScaleFactor: 3 } }, { slowMo: 501 },
    { navigationTimeout: 9 }, { locale: 'not a locale' }, { timezone: 'wrong/timezone' },
    { geolocation: { latitude: 91, longitude: 0 } }
  ])('拒绝无效配置 %#', (raw) => { expect(browserOptionsSchema.safeParse(raw).success).toBe(false) })
  it('请求头重复、受管字段、控制字符及字节限制', () => {
    for (const name of ['Cookie', 'Authorization', 'Proxy-Authorization', 'Host', 'Content-Length', 'Connection', 'User-Agent', 'Accept-Language', 'Sec-CH-UA-Mobile']) expect(extraHeadersSchema.safeParse([{ name, value: 'x' }]).success).toBe(false)
    expect(extraHeadersSchema.safeParse([{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }]).success).toBe(false)
    expect(extraHeadersSchema.safeParse([{ name: 'X-A', value: '\r' }]).success).toBe(false)
    expect(extraHeadersSchema.safeParse([{ name: 'X-A', value: '中'.repeat(3000) }]).success).toBe(false)
    expect(extraHeadersSchema.safeParse(Array.from({ length: 5 }, (_, i) => ({ name: `X-${i}`, value: 'a'.repeat(8192) }))).success).toBe(false)
  })
  it('代理不允许内嵌凭据、路径、参数和非法协议', () => {
    for (const server of ['http://user:pass@localhost:8080', 'http://localhost:8080/path', 'https://localhost?q=1', 'file:///tmp', '--proxy-server=x', 'socks5://localhost:99999']) expect(proxySchema.safeParse({ server }).success).toBe(false)
    expect(proxySchema.safeParse({ server: 'socks5://[::1]:1080' }).success).toBe(true)
  })
  it('指纹忽略名称标签和请求头排列，保留凭据引用及真实设置', () => {
    const headers = [{ name: 'X-B', value: 'b' }, { name: 'X-A', value: 'a' }]
    expect(browserOptionsFingerprint({ preset: 'custom', extraHTTPHeaders: headers })).toBe(browserOptionsFingerprint({ extraHTTPHeaders: [...headers].reverse(), locale: '' }))
    expect(browserOptionsFingerprint({}, 'a')).not.toBe(browserOptionsFingerprint({}, 'b'))
    expect(browserOptionsFingerprint({ slowMo: 1 })).not.toBe(browserOptionsFingerprint({}))
  })
  it('动态 contain 坐标排除留白、夹紧，实际区域拒绝越界', () => {
    const viewport = { width: 390, height: 844 }, rect = { left: 0, top: 0, width: 1000, height: 844 }
    expect(mapPoint(rect, 500, 422, false, viewport)).toEqual({ x: 195, y: 422 })
    expect(mapPoint(rect, 10, 422, false, viewport)).toBeNull()
    expect(mapPoint(rect, 2000, 2000, true, viewport)).toEqual({ x: 389, y: 843 })
    expect(mapPoint(rect, 500, 422, false, viewport, { width: 780, height: 1688 })).toEqual({ x: 195, y: 422 })
    expect(() => validatePoint({ x: 390, y: 0 }, { ...viewport, offsetX: 0, offsetY: 0, scale: 1 })).toThrow('可见区域')
  })
})

describe('凭据加密、事务和 MCP 兼容', () => {
  it('MCP 省略保留，空对象重置，凭据不进入快照/列表，失败不覆盖旧密文', async () => {
    const { dir, manager, store, vault } = await fixture()
    try {
      const credentials = { username: 'proxy-user-private', password: 'proxy-password-private' }
      const id = await manager.saveSite(undefined, { name: '代理', url: 'https://example.com', browserOptions: { preset: 'iphone', proxy: { server: 'http://localhost:8080' } } }, credentials)
      const previous = store.site(id), reference = previous.proxyCredentialId!
      expect(await vault.read(reference)).toEqual(credentials)
      expect(await readFile(path.join(dir, 'proxy-credentials', `${reference}.enc`), 'utf8')).not.toContain(credentials.password)
      expect(JSON.stringify(store.get())).not.toContain(credentials.username)
      const save = TOOLS.find((t) => t.name === 'save_site')!
      await save.run(manager, { site_id: id, name: '改名', url: previous.url })
      expect(store.site(id).browserOptions).toEqual(previous.browserOptions)
      expect(store.site(id).proxyCredentialId).toBe(reference)
      const update = vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('磁盘故障'))
      await expect(manager.saveSite(id, { name: '失败', url: previous.url }, { username: 'replacement', password: 'new-secret' })).rejects.toThrow('磁盘故障')
      update.mockRestore()
      expect(store.site(id).proxyCredentialId).toBe(reference)
      expect(await readdir(path.join(dir, 'proxy-credentials'))).toEqual([`${reference}.enc`])
      expect(await vault.read(reference)).toEqual(credentials)
      const list = JSON.stringify(await TOOLS.find((t) => t.name === 'list_sites')!.run(manager, {}))
      expect(list).not.toContain(credentials.password); expect(list).not.toContain(credentials.username)
      await save.run(manager, { site_id: id, name: '重置', url: previous.url, browserOptions: {} })
      expect(store.site(id).browserOptions).toEqual(browserOptionsSchema.parse({}))
      expect(store.site(id).proxyCredentialId).toBeUndefined()
      expect(await vault.read(reference)).toEqual(credentials)
      await manager.saveSite(id, { name: '下一版本', url: previous.url })
      await expect(vault.read(reference)).rejects.toThrow('代理凭据')
    } finally { await manager.shutdown() }
  })
  it('认证失败不降级明文，SOCKS5 不接受密码，损坏备份保守保留', async () => {
    const { dir, manager, vault } = await fixture()
    try {
      const broken = new ProxyVault(dir, { encrypt: async () => { throw new Error('private') }, decrypt: async () => { throw new Error('private') } })
      await expect(broken.create({ username: 'user', password: 'password' })).rejects.toThrow('代理凭据加密保存失败')
      await expect(manager.saveSite(undefined, { name: '无效', url: 'https://example.com', browserOptions: { proxy: { server: 'socks5://localhost:1080' } } }, { username: 'user', password: 'password' })).rejects.toThrow('仅支持 HTTP/HTTPS')
      const reference = await vault.create({ username: 'user', password: 'password' })
      await writeFile(path.join(dir, 'config.json.bak'), 'invalid')
      await vault.collect(new Set())
      expect((await vault.read(reference)).username).toBe('user')
      await expect(broken.read(reference)).rejects.toThrow('代理凭据读取或解密失败')
    } finally { await manager.shutdown() }
  })
  it('MCP 滚动中心使用目标页尺寸，截图返回图像和 CSS 度量', async () => {
    const geometry = { width: 980, height: 2120, offsetX: 0, offsetY: 0, scale: 0.4 }
    const manager = { geometry: vi.fn().mockResolvedValue(geometry), agentInput: vi.fn(), screenshot: vi.fn().mockResolvedValue({ tabId: 'tab', data: 'jpeg', image: { width: 1170, height: 2532 }, geometry }) } as unknown as BrowserManager
    const id = randomUUID()
    await TOOLS.find((t) => t.name === 'scroll')!.run(manager, { site_id: id, delta_y: 100 })
    expect(manager.agentInput).toHaveBeenCalledWith(id, undefined, { type: 'wheel', x: 490, y: 1060, deltaX: 0, deltaY: 100 })
    const shot = await TOOLS.find((t) => t.name === 'capture_screenshot')!.run(manager, { site_id: id })
    expect(shot[0].type).toBe('text'); expect(shot[1]).toMatchObject({ type: 'image', data: 'jpeg' })
  })
})

describe('页面配置基础值', () => {
  it('弹窗通过 CDP 应用视口，不调用会重放 POST 的 setViewport', async () => {
    const page = Object.fromEntries(['setDefaultNavigationTimeout', 'setViewport', 'setUserAgent', 'evaluateOnNewDocument', 'evaluate', 'emulateLocale', 'emulateTimezone', 'setGeolocation', 'setJavaScriptEnabled', 'setCacheEnabled', 'setExtraHTTPHeaders'].map((key) => [key, vi.fn().mockResolvedValue(undefined)]))
    const session = { send: vi.fn().mockResolvedValue(undefined) }
    const options = browserOptionsSchema.parse({ preset: 'iphone', locale: 'zh-CN', timezone: 'Asia/Shanghai', navigationTimeout: 12, cacheEnabled: false, javaScriptEnabled: false })
    await applyPageOptions(page as unknown as Page, options, 30, session as unknown as CDPSession)
    expect(page.setViewport).not.toHaveBeenCalled()
    expect(session.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 390, height: 844, mobile: true, deviceScaleFactor: 3 }))
    expect(page.setDefaultNavigationTimeout).toHaveBeenCalledWith(12000)
    expect(page.setCacheEnabled).toHaveBeenCalledWith(false)
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false)
    expect(connectionOptions(options, 30)).toEqual({ slowMo: 0, acceptInsecureCerts: false, navigationTimeout: 12 })
    expect(connectionOptions(browserOptionsSchema.parse({ slowMo: 500, acceptInsecureCerts: true }), 11)).toEqual({ slowMo: 500, acceptInsecureCerts: true, navigationTimeout: 11 })
  })
})

describe('代理认证拦截与流', () => {
  it('截图与输入互斥，截图失败后仍释放页面队列', async () => {
    const session = { send: vi.fn().mockResolvedValue({ cssVisualViewport: { clientWidth: 390, clientHeight: 844, offsetX: 0, offsetY: 0, scale: 1 } }), detach: vi.fn().mockResolvedValue(undefined) }
    let finish!: (data: string) => void
    const screenshot = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const page = { createCDPSession: async () => session, isClosed: () => false, screenshot } as unknown as Page
    const input = new PageInput(page, true)
    const capture = pageScreenshot(page, 70)
    await vi.waitFor(() => expect(screenshot).toHaveBeenCalledOnce())
    expect(isPageCapturing(page)).toBe(true)
    const touch = input.run({ type: 'down', x: 100, y: 330, button: 'left', clickCount: 1 })
    await Promise.resolve()
    expect(session.send.mock.calls.some(([name]) => name === 'Input.dispatchTouchEvent')).toBe(false)
    finish('jpeg'); await capture; await touch
    expect(isPageCapturing(page)).toBe(false)
    expect(session.send).toHaveBeenCalledWith('Input.dispatchTouchEvent', expect.objectContaining({ type: 'touchStart' }))
    screenshot.mockRejectedValueOnce(new Error('截图失败'))
    await expect(pageScreenshot(page, 70)).rejects.toThrow('截图失败')
    expect(isPageCapturing(page)).toBe(false)
    await input.run({ type: 'up', x: 100, y: 330, button: 'left', clickCount: 1 })
    await input.dispose()
  })
  it('丢弃截图期间和恢复后不匹配实际区域的过渡帧', async () => {
    const session = Object.assign(new EventEmitter(), { send: vi.fn().mockResolvedValue({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800, offsetX: 0, offsetY: 0, scale: 1 } }), detach: vi.fn().mockResolvedValue(undefined) })
    const transient = { data: 'transient', sessionId: 1, metadata: { deviceWidth: 756, deviceHeight: 469, pageScaleFactor: 1 } }
    const page = { createCDPSession: async () => session, isClosed: () => false, screenshot: async () => { session.emit('Page.screencastFrame', transient); return 'snapshot' } } as unknown as Page
    const frames: Frame[] = []; let sequence = 0
    const stream = new PageStream(page, { siteId: 'site', generation: 'generation', tabId: 'tab' }, () => ({ fps: 30, quality: 70 }), () => ++sequence, (frame) => frames.push(frame), vi.fn())
    try {
      await stream.start(); await vi.waitFor(() => expect(frames).toHaveLength(1))
      stream.mailbox.acknowledge(frames[0])
      session.emit('Page.screencastFrame', transient)
      session.emit('Page.screencastFrame', { ...transient, data: 'valid', metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 } })
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      expect(frames.map((frame) => frame.data)).toEqual(['snapshot', 'valid'])
      expect(frames.every((frame) => frame.geometry?.width === 1280)).toBe(true)
    } finally { await stream.stop() }
  })
  it('只响应匹配代理的首次挑战，源站 401 不获得代理密码', async () => {
    const server = 'http://127.0.0.1:8080'
    const challenge = { source: 'Proxy' as const, origin: server, scheme: 'basic', realm: 'fixture' }
    expect(matchesProxyChallenge(server, challenge)).toBe(true)
    expect(matchesProxyChallenge(server, { ...challenge, source: 'Server' })).toBe(false)
    expect(matchesProxyChallenge(server, { ...challenge, origin: 'http://evil.test' })).toBe(false)
    const session = Object.assign(new EventEmitter(), { send: vi.fn().mockResolvedValue({}), detach: vi.fn().mockResolvedValue(undefined) })
    const page = { createCDPSession: async () => session as unknown as CDPSession } as Page
    const interception = new PageInterception(page, 'tab', undefined, vi.fn(), { server, credentials: { username: 'user', password: 'secret' } })
    await interception.start()
    for (const [requestId, authChallenge] of [['1', challenge], ['1', challenge], ['2', { ...challenge, source: 'Server' }]] as const) session.emit('Fetch.authRequired', { requestId, authChallenge })
    await vi.waitFor(() => expect(session.send.mock.calls.filter(([method]) => method === 'Fetch.continueWithAuth')).toHaveLength(3))
    const calls = session.send.mock.calls.filter(([method]) => method === 'Fetch.continueWithAuth').map(([, args]) => args.authChallengeResponse)
    expect(calls).toEqual([{ response: 'ProvideCredentials', username: 'user', password: 'secret' }, { response: 'CancelAuth' }, { response: 'CancelAuth' }])
    await interception.stop(); expect(session.eventNames()).toEqual([])
  })
  it('截图降级帧保留实际 CSS 区域并兼容纯身份 ACK', async () => {
    const geometry = { clientWidth: 980, clientHeight: 2120, offsetX: 0, offsetY: 0, scale: 0.4 }
    let sessionCount = 0
    const page = { createCDPSession: async () => { if (!sessionCount++) throw new Error('no screencast'); return { send: async () => ({ cssVisualViewport: geometry }), detach: async () => undefined } }, isClosed: () => false, screenshot: async () => 'jpeg' } as unknown as Page
    const frames: Frame[] = []
    const stream = new PageStream(page, { siteId: 'site', generation: 'generation', tabId: 'tab' }, () => ({ fps: 5, quality: 70 }), () => frames.length + 1, (frame) => frames.push(frame), vi.fn())
    try {
      await stream.start(); await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
      expect(frames[0].geometry).toEqual({ width: 980, height: 2120, offsetX: 0, offsetY: 0, scale: 0.4 })
      const { siteId, generation, tabId, sequence } = frames[0]
      stream.mailbox.acknowledge({ siteId, generation, tabId, sequence }); expect(stream.mailbox.inFlight).toBeUndefined()
    } finally { await stream.stop() }
  })
})
