import type { Page } from '@playwright/test'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Content } from '../../src/main/mcp/tools'
import type { BrowserOptionsDraft } from '../../src/shared/browser-options'
import type { Frame } from '../../src/shared/model'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import puppeteer from 'puppeteer-core'
import { applyPageOptions, jpegSize, pageGeometry, pageScreenshot, withPageOperation } from '../../src/main/browser/options'
import { PageStream } from '../../src/main/browser/stream'
import { browserOptionsSchema } from '../../src/shared/browser-options'
import { mapPoint } from '../../src/shared/coordinates'
import { scriptDraftSchema } from '../../src/shared/scripts'
import { addSite, command, launchDesktop, state, stopAll } from './helpers'

async function optionsSite() {
  type Report = { ua: string; platform: string; language: string; languages: string[]; locale: string; timezone: string; dpr: number; touch: number; width: number; height: number; scale: number; click: number; touches: number; drag: number; text: string; scroll: number; geo?: number[] }
  const reports = new Map<string, Report>(), headers = new Map<string, IncomingHttpHeaders>(), assets = new Map<string, number>(), documents = new Map<string, number>()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const id = url.searchParams.get('id') || 'default'
    if (url.pathname === '/report') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      reports.set(id, JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204); res.end(); return
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (url.pathname === '/cached.js') { assets.set(id, (assets.get(id) || 0) + 1); res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' }); res.end('window.assetLoaded = true;'); return }
    if (url.pathname === '/slow') return
    documents.set(id, (documents.get(id) || 0) + 1)
    headers.set(id, req.headers)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><html><head><title>设备配置验证</title>${url.searchParams.has('noMeta') ? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">'}<style>
      body{margin:0;height:6000px;background:#e8f2ee}input{position:absolute;left:40px;top:100px;width:260px;height:50px;font:20px sans-serif}button{position:absolute;left:40px;top:300px;width:140px;height:60px;touch-action:none}#drag{position:absolute;left:40px;top:450px;width:160px;height:60px;touch-action:none;background:green}#pulse{position:absolute;left:10px;top:10px;width:10px;height:10px;background:red}
      </style></head><body><script src="/cached.js?id=${encodeURIComponent(id)}"></script><input id="text"><button id="click">点按</button><div id="drag">拖动</div><div id="pulse"></div><script>
      let clicks=0,touches=0,drag=0,geo;
      document.querySelector('#click').onclick=()=>clicks++;
      document.addEventListener('touchstart',()=>touches++);
      const slider=document.querySelector('#drag');slider.onpointerdown=e=>slider.setPointerCapture(e.pointerId);slider.onpointermove=e=>{if(e.buttons)drag=e.clientX};
      ${url.searchParams.has('geo') ? 'navigator.geolocation.getCurrentPosition(p=>geo=[p.coords.latitude,p.coords.longitude,p.coords.accuracy]);' : ''}
      setInterval(()=>{document.querySelector('#pulse').style.opacity=String(.5+Math.sin(Date.now()/200)*.4);fetch('/report?id='+${JSON.stringify(id)},{method:'POST',body:JSON.stringify({ua:navigator.userAgent,platform:navigator.platform,language:navigator.language,languages:navigator.languages,locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,dpr:devicePixelRatio,touch:navigator.maxTouchPoints,width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,click:clicks,touches,drag,text:document.querySelector('#text').value,scroll:scrollY,geo})}).catch(()=>{})},150);
      </script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { reports, headers, assets, documents, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
async function mcp(page: Page) {
  const token = await page.evaluate(() => window.octo.secret({ type: 'create', draft: { alias: '浏览器配置验证', level: 'full' } }))
  if (!token.ok) throw new Error(token.error)
  const port = 48000 + Math.floor(Math.random() * 1000)
  await command(page, { type: 'mcp.save', settings: { enabled: true, port } })
  return async (name: string, args: unknown): Promise<Content[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${token.data.secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const reply = await response.json() as { result: { isError?: boolean; content: Content[] } }
    if (reply.result.isError) throw new Error(JSON.stringify(reply.result.content))
    return reply.result.content
  }
}
const text = (content: Content[]) => { const item = content.find((item) => item.type === 'text'); if (!item || item.type !== 'text') throw new Error('缺少文本结果'); return item.text }
async function target(page: Page, siteId: string) {
  const runtime = (await state(page)).runtimes.find((r) => r.siteId === siteId)!
  return { siteId, generation: runtime.generation, tabId: runtime.activeTabId! }
}

test('全局配置默认 UA 的表单保存、继承、启动快照与清空', async () => {
  const website = await optionsSite(), desktop = await launchDesktop(), { page } = desktop
  try {
    const site = await addSite(page, '继承全局 UA', `${website.origin}/?id=global`)
    await page.getByRole('button', { name: /全局配置/ }).click()
    await expect(page.getByRole('heading', { name: '全局配置', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /项目配置/ })).toHaveCount(0)
    const input = page.getByRole('textbox', { name: '全局默认 User-Agent', exact: true })
    await expect(input).toHaveValue('')
    await input.fill('Invalid\nUA')
    await page.getByRole('button', { name: /保存设置/ }).click()
    await expect(page.getByText('不能包含换行或控制字符', { exact: true })).toBeVisible()
    expect((await state(page)).config.settings.defaultUserAgent).toBe('')
    await input.fill('OctoGlobal/1.0')
    await page.getByRole('button', { name: /保存设置/ }).click()
    await expect.poll(async () => (await state(page)).config.settings.defaultUserAgent).toBe('OctoGlobal/1.0')
    expect(JSON.parse(await readFile(path.join(desktop.dataDir, 'config.json'), 'utf8')).settings.defaultUserAgent).toBe('OctoGlobal/1.0')
    await page.getByRole('button', { name: /工作台/ }).click()
    await page.getByRole('button', { name: /全局配置/ }).click()
    await expect(input).toHaveValue('OctoGlobal/1.0')
    const call = await mcp(page)
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(() => website.reports.get('global')?.ua).toBe('OctoGlobal/1.0')
    expect(website.headers.get('global')?.['user-agent']).toBe('OctoGlobal/1.0')
    expect((await state(page)).config.sites.find((s) => s.id === site.id)?.browserOptions.userAgent).toBeUndefined()
    expect((await state(page)).runtimes[0].browserOptionsPending).toBe(false)
    await call('save_settings', { default_user_agent: 'OctoGlobal/2.0' })
    expect((await state(page)).runtimes[0].browserOptionsPending).toBe(true)
    await call('navigate', { site_id: site.id, url: `${website.origin}/?id=global-running` })
    await expect.poll(() => website.reports.get('global-running')?.ua).toBe('OctoGlobal/1.0')
    expect(website.headers.get('global-running')?.['user-agent']).toBe('OctoGlobal/1.0')
    await call('open_tab', { site_id: site.id, url: `${website.origin}/?id=global-tab` })
    await expect.poll(() => website.reports.get('global-tab')?.ua).toBe('OctoGlobal/1.0')
    expect(website.headers.get('global-tab')?.['user-agent']).toBe('OctoGlobal/1.0')
    await call('save_settings', { default_user_agent: 'OctoGlobal/1.0' })
    expect((await state(page)).runtimes[0].browserOptionsPending).toBe(false)
    await call('save_settings', { default_user_agent: 'OctoGlobal/2.0' })
    await command(page, { type: 'browser.stop', siteId: site.id })
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(() => website.reports.get('global')?.ua).toBe('OctoGlobal/2.0')
    expect(website.headers.get('global')?.['user-agent']).toBe('OctoGlobal/2.0')
    expect((await state(page)).runtimes[0].browserOptionsPending).toBe(false)
    await input.fill('')
    await page.getByRole('button', { name: /保存设置/ }).click()
    await expect.poll(async () => (await state(page)).config.settings.defaultUserAgent).toBe('')
    expect((await state(page)).runtimes[0].browserOptionsPending).toBe(true)
    await command(page, { type: 'browser.stop', siteId: site.id })
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(() => website.reports.get('global')?.ua).toContain('Chrome/')
    expect(website.headers.get('global')?.['user-agent']).toBe(website.reports.get('global')?.ua)
    expect((await state(page)).runtimes[0].browserOptionsPending).toBe(false)
  } finally { await stopAll(desktop.application, page); await website.close() }
})

test('设备预设、UA、语言、定位、运行快照与 MCP 动态坐标', async () => {
  const website = await optionsSite(), desktop = await launchDesktop()
  const { page } = desktop
  try {
    const call = await mcp(page)
    await call('save_settings', { default_user_agent: 'PresetGlobal/1.0' })
    for (const preset of ['desktop', 'android', 'iphone', 'custom'] as const) {
      const options: BrowserOptionsDraft = { preset, locale: 'zh-CN', timezone: 'Asia/Shanghai', geolocation: { latitude: 31.2, longitude: 121.5, accuracy: 12 }, extraHTTPHeaders: [{ name: 'X-Octo-Device', value: preset }], ...(preset === 'custom' ? { userAgent: 'OctoCustom/1.0', viewport: { width: 960, height: 600, deviceScaleFactor: 2 }, platform: 'CustomPlatform' } : {}) }
      const { site_id: id } = JSON.parse(text(await call('save_site', { name: preset, url: `${website.origin}/?id=${preset}&geo`, browserOptions: options })))
      await command(page, { type: 'browser.start', siteId: id })
      await expect.poll(() => website.reports.get(preset)?.geo).toEqual([31.2, 121.5, 12])
      const report = website.reports.get(preset)!, received = website.headers.get(preset)!
      expect(report.language).toBe('zh-CN'); expect(report.languages[0]).toBe('zh-CN'); expect(report.locale).toBe('zh-CN'); expect(report.timezone).toBe('Asia/Shanghai')
      expect(received['accept-language']).toContain('zh-CN'); expect(received['user-agent']).toBe(report.ua); expect(received['x-octo-device']).toBe(preset)
      const expected = browserOptionsSchema.parse(options)
      if (preset === 'desktop') expect(report.ua).toBe('PresetGlobal/1.0')
      if (preset !== 'desktop') {
        await call('save_settings', { default_user_agent: 'PresetGlobal/2.0' })
        expect((await state(page)).runtimes.find((r) => r.siteId === id)?.browserOptionsPending).toBe(false)
      }
      expect(report.width).toBeCloseTo(expected.viewport.width, 0); expect(report.dpr).toBe(expected.viewport.deviceScaleFactor)
      if (preset === 'android') { expect(report.ua).toContain(`Chrome/${(await state(page)).info.browserVersion}`); expect(received['sec-ch-ua-platform']).toBe('"Android"'); expect(received['sec-ch-ua-mobile']).toBe('?1'); expect(report.touch).toBeGreaterThan(0) }
      if (preset === 'iphone') { expect(report.ua).toContain('iPhone'); expect(received['sec-ch-ua']).toBeUndefined(); expect(report.touch).toBeGreaterThan(0) }
      if (preset === 'custom') { expect(report.ua).toBe('OctoCustom/1.0'); expect(report.platform).toBe('CustomPlatform'); expect(received['sec-ch-ua']).toBeUndefined() }
      const shot = JSON.parse(text(await call('capture_screenshot', { site_id: id })))
      expect(shot.image_pixels.width).toBe(expected.viewport.width * report.dpr)
      expect(shot.css_visible_region.width).toBeCloseTo(report.width, 0)
      await call('click', { site_id: id, x: 100, y: 330 })
      await expect.poll(() => website.reports.get(preset)?.click).toBe(1)
      await expect(call('click', { site_id: id, x: report.width + 1, y: 330 })).rejects.toThrow('可见区域')
      await call('scroll', { site_id: id, delta_y: 240 })
      await expect.poll(() => website.reports.get(preset)?.scroll).toBeGreaterThan(0)
      await call('save_site', { site_id: id, name: `改名 ${preset}`, url: `${website.origin}/?id=${preset}&geo` })
      expect((await state(page)).runtimes.find((r) => r.siteId === id)?.browserOptionsPending).toBe(false)
      await call('save_site', { site_id: id, name: preset, url: `${website.origin}/?id=${preset}&geo`, browserOptions: { userAgent: 'AfterRestart/1.0' } })
      expect((await state(page)).runtimes.find((r) => r.siteId === id)?.browserOptionsPending).toBe(true)
      await call('open_tab', { site_id: id, url: `${website.origin}/?id=${preset}-new` })
      await expect.poll(() => website.reports.get(`${preset}-new`)?.ua).toBe(report.ua)
      await call('save_site', { site_id: id, name: preset, url: `${website.origin}/?id=${preset}&geo`, browserOptions: options })
      expect((await state(page)).runtimes.find((r) => r.siteId === id)?.browserOptionsPending).toBe(false)
      await call('save_site', { site_id: id, name: preset, url: `${website.origin}/?id=${preset}&geo`, browserOptions: { userAgent: 'AfterRestart/1.0' } })
      await command(page, { type: 'browser.stop', siteId: id }); await command(page, { type: 'browser.start', siteId: id })
      await expect.poll(() => website.reports.get(preset)?.ua).toBe('AfterRestart/1.0')
      await command(page, { type: 'browser.stop', siteId: id })
    }
  } finally { await stopAll(desktop.application, page); await website.close() }
})

test('无 viewport meta 的移动触摸、拖动、中文与实时画面映射', async () => {
  const website = await optionsSite(), desktop = await launchDesktop()
  const { page } = desktop
  try {
    const site = await addSite(page, '无 meta 手机', `${website.origin}/?id=mobile&noMeta`)
    await command(page, { type: 'site.save', id: site.id, draft: { name: site.name, url: site.url, browserOptions: browserOptionsSchema.parse({ preset: 'iphone' }) } })
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(() => website.reports.get('mobile')?.width).toBeGreaterThan(900)
    const call = await mcp(page)
    const shot = JSON.parse(text(await call('capture_screenshot', { site_id: site.id })))
    expect(shot.css_visible_region.width).toBeCloseTo(website.reports.get('mobile')!.width, 0)
    await call('click', { site_id: site.id, x: 100, y: 330 })
    await expect.poll(() => website.reports.get('mobile')?.click).toBe(1)
    await expect.poll(() => website.reports.get('mobile')?.touches).toBeGreaterThan(0)
    await call('click', { site_id: site.id, x: 100, y: 120 }); await call('type_text', { site_id: site.id, text: '移动中文输入' })
    await expect.poll(() => website.reports.get('mobile')?.text).toBe('移动中文输入')
    await page.getByRole('button', { name: '放大操作' }).first().click()
    await expect(page.locator('.focus-canvas canvas')).toBeVisible()
    await command(page, { type: 'view', siteId: site.id, visible: true })
    const t = await target(page, site.id)
    await command(page, { type: 'input', ...t, input: { type: 'down', x: 80, y: 480, button: 'left', clickCount: 1 } })
    await command(page, { type: 'input', ...t, input: { type: 'move', x: 250, y: 480 } })
    await command(page, { type: 'input', ...t, input: { type: 'up', x: 250, y: 480, button: 'left', clickCount: 1 } })
    await expect.poll(() => website.reports.get('mobile')?.drag).toBeGreaterThan(200)
    await expect.poll(async () => (await state(page)).runtimes.find((r) => r.siteId === site.id)?.streamMode).toBe('live')
    const report = website.reports.get('mobile')!, box = (await page.locator('.focus-canvas canvas').boundingBox())!
    const scale = Math.min(box.width / report.width, box.height / report.height)
    await page.mouse.click(box.x + (box.width - report.width * scale) / 2 + 100 * scale, box.y + (box.height - report.height * scale) / 2 + 330 * scale)
    await expect.poll(() => website.reports.get('mobile')?.click).toBe(2)
  } finally { await stopAll(desktop.application, page); await website.close() }
})

test('表单预设仅改变设备，手动 UA 切自定义，凭据只显示已保存', async () => {
  const desktop = await launchDesktop(), { page } = desktop
  try {
    const site = await addSite(page, '编辑设备', 'https://example.com')
    await command(page, { type: 'site.save', id: site.id, draft: { name: site.name, url: site.url, browserOptions: browserOptionsSchema.parse({ proxy: { server: 'http://localhost:8080' }, locale: 'zh-CN' }) }, proxyCredentials: { username: 'private-user', password: 'private-password' } })
    await page.getByRole('button', { name: /页面管理/ }).click(); await page.getByRole('button', { name: '编辑配置' }).click()
    await page.getByRole('combobox', { name: '设备预设' }).click(); await page.getByText('iPhone 13', { exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '视口宽度' })).toHaveValue('390')
    await page.getByRole('textbox', { name: '自定义 User-Agent', exact: true }).fill('Manual-UA/1.0')
    await page.getByText('启动与网络', { exact: true }).click()
    await expect(page.getByText('已保存', { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '代理地址', exact: true })).toHaveValue('http://localhost:8080')
    await expect(page.getByLabel('代理密码', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const saved = (await state(page)).config.sites[0]
    expect(saved.browserOptions).toMatchObject({ preset: 'custom', userAgent: 'Manual-UA/1.0', viewport: { width: 390 }, locale: 'zh-CN' })
    expect(saved.proxyCredentialId).toBeTruthy()
    expect(await readFile(path.join(desktop.dataDir, 'config.json'), 'utf8')).not.toContain('private-password')
  } finally { await stopAll(desktop.application, page) }
})

async function execute<T = Record<string, unknown>>(page: Page, siteId: string, source: string): Promise<T> {
  const name = randomUUID()
  await command(page, { type: 'script.save', draft: scriptDraftSchema.parse({ name, match: ['127.0.0.1', 'fixture.test', 'localhost'], source }) })
  const scriptId = (await state(page)).scripts.find((script) => script.draft.name === name)!.id
  await command(page, { type: 'script.run', scriptId, siteId, values: {} })
  const runs = () => page.evaluate(async (id) => { const reply = await window.octo.scriptRuns(id); if (!reply.ok) throw new Error(reply.error); return reply.data }, scriptId)
  await expect.poll(async () => (await runs())[0]?.status).toBe('success')
  return JSON.parse((await runs())[0].result!) as T
}

test('JavaScript、缓存、项目和网站超时、Worker 基础配置及隔离', async () => {
  const website = await optionsSite(), desktop = await launchDesktop(), { page } = desktop
  try {
    const call = await mcp(page)
    await command(page, { type: 'script.save', draft: scriptDraftSchema.parse({ kind: 'injection', name: '基础配置探针', match: ['127.0.0.1'], source: `
      octo.interceptRequest({urlPattern:'*/?*'}, request => ({ headers:[...request.headers,{name:'X-Injection-Timeout',value:String(page.getDefaultNavigationTimeout())}] }));
      await page.evaluateOnNewDocument(() => { window.injectionInstalled = true; });
    ` }) })
    const scriptId = (await state(page)).scripts[0].id
    const a = await addSite(page, '手机有缓存', `${website.origin}/?id=cached`)
    const b = await addSite(page, '禁脚本无缓存', `${website.origin}/?id=disabled`)
    const base = browserOptionsSchema.parse({ preset: 'android', slowMo: 20, locale: 'zh-CN', timezone: 'Asia/Shanghai' })
    await command(page, { type: 'site.save', id: a.id, draft: { name: a.name, url: a.url, injections: [{ scriptId, enabled: true, values: {} }], browserOptions: base } })
    await command(page, { type: 'site.save', id: b.id, draft: { name: b.name, url: b.url, browserOptions: browserOptionsSchema.parse({ javaScriptEnabled: false, cacheEnabled: false, navigationTimeout: 10 }) } })
    await command(page, { type: 'browser.start', siteId: a.id }); await command(page, { type: 'browser.start', siteId: b.id })
    await expect.poll(() => website.reports.get('cached')?.touch).toBeGreaterThan(0)
    const read = `const start=Date.now(); for(let i=0;i<4;i++) await page.title(); return { elapsed:Date.now()-start, timeout:page.getDefaultNavigationTimeout(), ...await page.evaluate(() => ({ ua:navigator.userAgent, platform:navigator.platform, width:innerWidth, dpr:devicePixelRatio, injected:window.injectionInstalled===true, asset:window.assetLoaded===true, locale:Intl.DateTimeFormat().resolvedOptions().locale })) };`
    const current = await execute(page, a.id, read)
    expect(current).toMatchObject({ width: 393, dpr: 3, injected: true, asset: true, locale: 'zh-CN', timeout: 30000 })
    expect(current.elapsed).toBeGreaterThanOrEqual(75)
    expect(await execute(page, b.id, read)).toMatchObject({ width: 1280, dpr: 1, injected: false, asset: false, timeout: 10000 })
    expect(website.reports.has('disabled')).toBe(false)
    await call('navigate', { site_id: a.id, url: `${a.url}&again=1` })
    await expect.poll(() => website.reports.get('cached')?.platform).toBe('Linux armv8l')
    expect(website.assets.get('cached')).toBe(1)
    const settings = (await state(page)).config.settings
    await command(page, { type: 'settings.save', settings: { ...settings, navigationTimeout: 12 } })
    await call('navigate', { site_id: a.id, url: `${a.url}&again=2` })
    expect(website.headers.get('cached')?.['x-injection-timeout']).toBe('12000')
    expect(await execute(page, a.id, read)).toMatchObject({ timeout: 12000, width: 393 })
    expect(await execute(page, b.id, read)).toMatchObject({ timeout: 10000 })
    const started = Date.now()
    await expect(call('navigate', { site_id: b.id, url: `${website.origin}/slow` })).rejects.toThrow('导航失败')
    expect(Date.now() - started).toBeGreaterThanOrEqual(9500)
    await call('stop_site', { site_id: b.id })
    await call('save_site', { site_id: b.id, name: b.name, url: b.url, browserOptions: { cacheEnabled: false } })
    await call('start_site', { site_id: b.id })
    await expect.poll(() => website.reports.get('disabled')?.width).toBe(1280)
    const count = website.assets.get('disabled')!
    await call('navigate', { site_id: b.id, url: `${b.url}&again=1` })
    expect(website.assets.get('disabled')).toBeGreaterThan(count)
  } finally { await stopAll(desktop.application, page); await website.close() }
})

test('横屏 iPad、有头启动、POST 弹窗不重放及关闭最后标签', async () => {
  const website = await optionsSite(), desktop = await launchDesktop(), { page } = desktop
  try {
    const call = await mcp(page)
    const site = await addSite(page, '横屏平板', `${website.origin}/?id=landscape`)
    const preset = browserOptionsSchema.parse({ preset: 'ipad' })
    await command(page, { type: 'site.save', id: site.id, draft: { name: site.name, url: site.url, browserOptions: { ...preset, headless: false, viewport: { ...preset.viewport, width: 1024, height: 768, isLandscape: true } } } })
    await call('start_site', { site_id: site.id })
    await expect.poll(() => website.reports.get('landscape')?.width).toBe(1024)
    expect(await execute(page, site.id, `return page.evaluate(() => ({ orientation:screen.orientation.type, dpr:devicePixelRatio }));`)).toEqual({ orientation: 'landscape-primary', dpr: 2 })
    await execute(page, site.id, `await page.evaluate(() => { const form=document.createElement('form');form.method='POST';form.target='popup';form.action='/?id=popup';document.body.append(form);form.submit(); }); return true;`)
    await expect.poll(async () => (await state(page)).runtimes[0].tabs.length).toBe(2)
    await expect.poll(() => website.reports.get('popup')?.width).toBe(1024)
    expect(website.documents.get('popup')).toBe(1)
    await call('navigate', { site_id: site.id, url: `${website.origin}/?id=popup-next` })
    await expect.poll(() => website.reports.get('popup-next')?.platform).toBe('iPad')
    const runtime = (await state(page)).runtimes[0]
    for (const tab of runtime.tabs) await command(page, { type: 'tab.close', siteId: site.id, generation: runtime.generation, tabId: tab.id })
    await expect.poll(async () => {
      const current = (await state(page)).runtimes[0]
      const replacement = current.tabs[0]
      return current.tabs.length === 1 && replacement?.id === current.activeTabId && !runtime.tabs.some((tab) => tab.id === replacement.id)
    }).toBe(true)
    await call('navigate', { site_id: site.id, url: `${website.origin}/?id=replacement` })
    await expect.poll(() => website.reports.get('replacement')?.width).toBe(1024)
    expect(website.reports.get('replacement')?.dpr).toBe(2)
  } finally { await stopAll(desktop.application, page); await website.close() }
})

test('真实截图降级保留高 DPR 与无 meta 页面的 CSS 映射', async () => {
  const website = await optionsSite()
  const root = path.join(process.cwd(), '.browsers', process.arch)
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as { executable: string }
  const browser = await puppeteer.launch({ executablePath: path.join(root, manifest.executable), defaultViewport: null, headless: true })
  let stream: PageStream | undefined
  try {
    const page = (await browser.pages())[0]
    await applyPageOptions(page, browserOptionsSchema.parse({ preset: 'iphone' }), 30)
    await page.goto(`${website.origin}/?id=fallback&noMeta`)
    const original = page.createCDPSession.bind(page)
    let first = true
    page.createCDPSession = async () => { if (first) { first = false; throw new Error('模拟 screencast 不可用') } return original() }
    const frames: Frame[] = [], modes: string[] = []
    let sequence = 0
    stream = new PageStream(page, { siteId: 'site', generation: 'generation', tabId: 'tab' }, () => ({ fps: 5, quality: 70 }), () => ++sequence, (frame) => frames.push(frame), (mode) => modes.push(mode))
    await stream.start()
    await expect.poll(() => frames.length).toBeGreaterThan(0)
    expect(modes).toContain('fallback')
    const frame = frames[0], geometry = frame.geometry!, image = jpegSize(frame.data)
    expect(image.width).toBe(1170); expect(geometry.width).toBeGreaterThan(900)
    const scale = Math.min(1000 / image.width, 700 / image.height)
    const x = (1000 - image.width * scale) / 2 + 100 / geometry.width * image.width * scale
    const y = (700 - image.height * scale) / 2 + 330 / geometry.height * image.height * scale
    const point = mapPoint({ left: 0, top: 0, width: 1000, height: 700 }, x, y, false, geometry, image)!
    expect(point.x).toBeCloseTo(100, 6); expect(point.y).toBeCloseTo(330, 6)
    const session = await original(), current = await withPageOperation(page, () => pageGeometry(page, session))
    for (let count = 1; count <= 5; count++) {
      await withPageOperation(page, () => session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x + current.offsetX, y: point.y + current.offsetY, id: 0 }] }))
      // 主动制造截图与抬指并发，验证高 DPR 合成器的临时缩放不会污染输入。
      await Promise.all([pageScreenshot(page, 70, session), withPageOperation(page, () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }))])
      await expect.poll(() => website.reports.get('fallback')?.click).toBe(count)
    }
    await session.detach()
  } finally { await stream?.stop(); await browser.close(); await website.close() }
})

async function proxyFixture(directory: string, secureProxy: boolean) {
  await mkdir(directory, { recursive: true })
  const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  const tls = { key: await readFile(keyFile), cert: await readFile(certFile) }
  const requests: { url: string; auth?: string; sourceAuth?: string }[] = []
  const credentials = { username: 'fixture-user', password: 'fixture-password' }, expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
  const html = '<html><head><title>代理连接成功</title></head><body>proxy-ok</body></html>'
  const origin = createHttpsServer(tls, (req, res) => { requests.push({ url: `origin:${req.url}`, sourceAuth: req.headers.authorization }); res.setHeader('content-type', 'text/html'); res.end(html) })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.includes('fixture.test')) { res.writeHead(200); res.end(); return }
    requests.push({ url: req.url, auth: req.headers['proxy-authorization'] as string | undefined, sourceAuth: req.headers.authorization })
    if (req.headers['proxy-authorization'] !== expected) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end(); return }
    if (req.url.includes('/source-auth')) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="origin"' }); res.end('source-auth'); return }
    res.setHeader('content-type', 'text/html'); res.end(html)
  }
  const proxy = secureProxy ? createHttpsServer(tls, handler) : createServer(handler)
  const sockets = new Set<ReturnType<typeof connect>>()
  proxy.on('connect', (req, socket, head) => {
    if (!req.url?.includes('fixture.test')) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    requests.push({ url: `CONNECT:${req.url}`, auth: req.headers['proxy-authorization'] as string | undefined })
    if (req.headers['proxy-authorization'] !== expected) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n'); return }
    const upstream = connect((origin.address() as { port: number }).port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return { credentials, requests, server: `${secureProxy ? 'https' : 'http'}://127.0.0.1:${(proxy.address() as { port: number }).port}`, tlsUrl: `https://fixture.test:${(origin.address() as { port: number }).port}/`, close: async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([proxy, origin].map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
  } }
}

test('HTTP/HTTPS 代理认证、CONNECT、源站 401 与证书安全默认值', async () => {
  const desktop = await launchDesktop(), { page } = desktop
  try {
    const call = await mcp(page)
    for (const secure of [false, true]) {
      const proxy = await proxyFixture(path.join(desktop.dataDir, secure ? 'tls-proxy' : 'http-proxy'), secure)
      try {
        const options = { proxy: { server: proxy.server }, acceptInsecureCerts: secure }
        const { site_id: id } = JSON.parse(text(await call('save_site', { name: `代理 ${secure}`, url: 'http://fixture.test/', browserOptions: options, proxy_credentials: proxy.credentials })))
        if (secure) {
          await call('save_site', { site_id: id, name: '代理证书默认拒绝', url: 'http://fixture.test/', browserOptions: { ...options, acceptInsecureCerts: false } })
          await call('start_site', { site_id: id })
          await expect.poll(async () => text(await call('read_page', { site_id: id }))).toContain('ERR_PROXY_CERTIFICATE_INVALID')
          await call('stop_site', { site_id: id })
          await call('save_site', { site_id: id, name: '允许测试代理证书', url: 'http://fixture.test/', browserOptions: options })
        }
        await call('start_site', { site_id: id })
        await expect.poll(async () => text(await call('read_page', { site_id: id }))).toContain('proxy-ok')
        await call('navigate', { site_id: id, url: 'http://fixture.test/source-auth' }).catch((error) => { expect(String(error)).toContain('导航失败') })
        expect(proxy.requests.some((r) => r.url.includes('/source-auth'))).toBe(true)
        expect(proxy.requests.every((r) => !r.sourceAuth)).toBe(true)
        if (!secure) {
          await expect(call('navigate', { site_id: id, url: proxy.tlsUrl })).rejects.toThrow('导航失败')
          await call('stop_site', { site_id: id })
          await call('save_site', { site_id: id, name: '允许测试证书', url: proxy.tlsUrl, browserOptions: { ...options, acceptInsecureCerts: true } })
          await call('start_site', { site_id: id })
        } else {
          await call('navigate', { site_id: id, url: proxy.tlsUrl })
        }
        await expect.poll(async () => text(await call('read_page', { site_id: id }))).toContain('proxy-ok')
        expect(proxy.requests.some((r) => r.url.startsWith('CONNECT:') && r.auth)).toBe(true)
        expect(proxy.requests.filter((r) => r.url.startsWith('origin:')).every((r) => !r.sourceAuth)).toBe(true)
        const snapshot = JSON.stringify(await state(page))
        expect(snapshot).not.toContain(proxy.credentials.username); expect(snapshot).not.toContain(proxy.credentials.password)
        await call('stop_site', { site_id: id })
        await call('save_site', { site_id: id, name: '错误认证', url: 'http://fixture.test/wrong', browserOptions: options, proxy_credentials: { ...proxy.credentials, password: 'wrong-password' } })
        await call('start_site', { site_id: id })
        await expect.poll(async () => (await state(page)).runtimes.find((r) => r.siteId === id)?.warning).toContain('认证被拒绝')
        expect(proxy.requests.filter((r) => r.url.includes('/wrong')).length).toBeLessThanOrEqual(3)
        await call('stop_site', { site_id: id })
      } finally { await proxy.close() }
    }
  } finally { await stopAll(desktop.application, page) }
})
