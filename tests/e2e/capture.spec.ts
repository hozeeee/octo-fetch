import type { Server as NetServer, Socket } from 'node:net'
import type { ScriptKind } from '../../src/shared/scripts'
import { X509Certificate } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { browserOptionsSchema } from '../../src/shared/browser-options'
import { captureSettingsSchema } from '../../src/shared/capture'
import { scriptDraftSchema } from '../../src/shared/scripts'
import { command, launchDesktop, state, stopAll } from './helpers'

async function proxyFixture(expectedAuth?: string) {
  const received: { url?: string; auth?: string; marker?: string }[] = []
  let finishStream = () => {}
  const server = createServer((req, res) => {
    received.push({ url: req.url, auth: req.headers['proxy-authorization'], marker: req.headers['x-capture-test'] as string | undefined })
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end('认证失败'); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const url = new URL(req.url!, 'http://same.example')
    if (url.pathname === '/compressed') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Set-Cookie', ['a=1', 'b=2'])
      res.end(gzipSync('压缩正文'.repeat(100))); return
    }
    if (url.pathname === '/stream') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.write('开始'); finishStream = () => res.end('结束'); return }
    if (url.pathname === '/bad-gzip') { res.setHeader('Content-Encoding', 'gzip'); res.end('invalid gzip'); return }
    if (url.pathname === '/corrupt-gzip') { res.setHeader('Content-Encoding', 'gzip'); res.end(Buffer.from([31, 139, 8, 0])); return }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: '/binary' }); res.end(); return }
    if (url.pathname === '/binary') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(Buffer.from([0, 255, 128, 1])); return }
    if (url.pathname === '/slow') { res.end(Buffer.alloc(4096, 65)); return }
    if (url.pathname === '/oversized') { res.setHeader('Content-Length', 2100000); res.end(Buffer.alloc(2100000, 65)); return }
    res.end('<html><title>抓包租约</title><body>capture-product-ok</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port, received, finishStream: () => finishStream() }
}
function proxyRequest(port: number, url: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: url, headers: { host: new URL(url).host } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk }); res.on('end', () => resolve(text)); res.on('error', reject)
    })
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error(`代理超时：${url}`))); req.end()
  })
}

test('产品抓包页面、端口冲突、浏览器租约、隔离视图与配置待生效', async () => {
  // 包内跨架构运行包含多次进程启动，总预算不改变各操作自身的超时。
  test.setTimeout(process.env.OCTO_TEST_EXECUTABLE ? 240000 : 90000)
  const desktop = await launchDesktop(), { page, application } = desktop
  const upstream = await proxyFixture()
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  try {
    await page.getByRole('button', { name: /抓包调试/ }).click()
    await expect(page.getByRole('heading', { name: '抓包调试', exact: true })).toBeVisible()
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port }) })
    await expect(command(page, { type: 'capture.start' })).rejects.toThrow('端口已占用')
    expect((await state(page)).capture.status).toBe('error')
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    await page.getByRole('button', { name: /启动代理/ }).click()
    await expect.poll(async () => (await state(page)).capture.status).toBe('running')
    const first = (await state(page)).capture
    expect(first.fingerprint).toMatch(/^[A-F0-9:]+$/)
    expect(JSON.stringify(first)).not.toMatch(/username|password|uiPort|spki/)
    const caFile = path.join(desktop.dataDir, 'capture', '.whistle', 'certs', 'root.crt')
    expect(await readFile(caFile, 'utf8')).toContain('BEGIN CERTIFICATE')
    expect((await stat(caFile.replace(/crt$/, 'key'))).mode & 0o777).toBe(0o600)
    const exported = path.join(desktop.dataDir, 'exported-ca.crt')
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, exported)
    await command(page, { type: 'capture.certificate.export' })
    expect(new X509Certificate(await readFile(exported)).raw).toEqual(new X509Certificate(await readFile(caFile)).raw)
    expect(await readFile(exported, 'utf8')).not.toContain('PRIVATE KEY')
    await expect(command(page, { type: 'capture.certificate.reset' })).rejects.toThrow('停止')
    await expect.poll(() => application.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child instanceof WebContentsView && child.getVisible()))).toBe(true)
    await expect.poll(() => application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child instanceof WebContentsView) as Electron.WebContentsView
      return view.webContents.executeJavaScript('document.body.innerText')
    })).toContain('Network')
    const isolated = await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child instanceof WebContentsView) as Electron.WebContentsView
      return view.webContents.executeJavaScript('({octo:typeof window.octo,node:typeof require,process:typeof process})')
    })
    expect(isolated).toEqual({ octo: 'undefined', node: 'undefined', process: 'undefined' })
    await page.getByRole('tab', { name: '接入与证书', exact: true }).click()
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every((child) => !child.getVisible()))).toBe(true)
    await command(page, { type: 'site.save', draft: { name: '抓包网站', url: 'http://same.example/product', captureEnabled: true, browserOptions: browserOptionsSchema.parse({ proxy: { server: `http://127.0.0.1:${upstream.port}`, bypass: ['*.internal'] } }) }, proxyCredentials: { username: 'fixture', password: 'fixture-password' } })
    const site = (await state(page)).config.sites[0]
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(async () => {
      const reply = await page.evaluate((siteId) => window.octo.captureQuery({ siteId, url: '/product' }), site.id)
      return reply.ok ? reply.data.items.length : 0
    }).toBeGreaterThan(0)
    await expect.poll(() => upstream.received.find((item) => item.url === 'http://same.example/product')?.auth).toBe(`Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`)
    expect((await state(page)).config.sites[0].browserOptions.proxy).toEqual(site.browserOptions.proxy)
    expect((await state(page)).runtimes[0].captureActive).toBe(true)
    expect((await state(page)).capture.sites).toEqual([site.id])
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await command(page, { type: 'capture.stop' })
    expect((await state(page)).capture.status).toBe('running')
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port, https: false }) })
    expect((await state(page)).capture.pending).toBe(true)
    await command(page, { type: 'capture.site', siteId: site.id, enabled: false })
    expect((await state(page)).runtimes[0]).toMatchObject({ captureActive: true, capturePending: true })
    await command(page, { type: 'browser.stop', siteId: site.id })
    expect((await state(page)).capture.sites).toEqual([])
    await command(page, { type: 'capture.restart' })
    expect((await state(page)).capture).toMatchObject({ pending: false, fingerprint: first.fingerprint })
    expect((await state(page)).capture.generation).not.toBe(first.generation)
    expect(await proxyRequest(port, `http://127.0.0.1:${upstream.port}/external`)).toContain('capture-product-ok')
    await command(page, { type: 'capture.stop' })
    await expect(proxyRequest(port, `http://127.0.0.1:${upstream.port}/external`)).rejects.toThrow()
    await command(page, { type: 'capture.site', siteId: site.id, enabled: true })
    await expect(command(page, { type: 'browser.start', siteId: site.id })).rejects.toThrow('抓包代理未运行')
    expect((await state(page)).capture.sites).toEqual([])
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await command(page, { type: 'capture.certificate.reset' })
    await command(page, { type: 'capture.start' })
    expect((await state(page)).capture.fingerprint).not.toBe(first.fingerprint)
    await command(page, { type: 'capture.stop' })
  } finally {
    reservation.close(); upstream.server.closeAllConnections(); upstream.server.close()
    await stopAll(application, page)
  }
})

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
test('三类真实脚本抓包通道、授权界面、撤销与 MCP HTTP 权限矩阵', async () => {
  test.setTimeout(process.env.OCTO_TEST_EXECUTABLE ? 300000 : 120000)
  const desktop = await launchDesktop(), { page, application } = desktop, upstream = await proxyFixture()
  // 手动创建的 Electron context 不随 Playwright fixture 自动收集浏览器轨迹。
  if (process.env.OCTO_TEST_TRACE) await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  try {
    const port = await freePort()
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port, allowScripts: true }) })
    await command(page, { type: 'capture.start' })
    const save = async (name: string, kind: ScriptKind, source: string) => {
      await command(page, { type: 'script.save', draft: scriptDraftSchema.parse({ name, kind, source, match: kind === 'sandbox' ? [] : ['same.example'], sandbox: kind === 'sandbox' ? { mode: 'once' } : undefined }) })
      return (await state(page)).scripts.find((script) => script.draft.name === name)!
    }
    const runs = (id: string) => page.evaluate(async (id) => { const result = await window.octo.scriptRuns(id); if (!result.ok) throw new Error(result.error); return result.data }, id)
    const run = async (scriptId: string, siteId?: string) => {
      if (siteId) {
        await expect.poll(async () => {
          const runtime = (await state(page)).runtimes.find((item) => item.siteId === siteId)
          return runtime?.tabs.find((tab) => tab.id === runtime.activeTabId)?.url
        }).toBe('http://same.example/own')
      }
      const previous = new Set((await runs(scriptId)).map((item) => item.id))
      await command(page, { type: 'script.run', scriptId, siteId, values: {} })
      await expect.poll(async () => (await runs(scriptId)).some((item) => !previous.has(item.id) && item.status !== 'running')).toBe(true)
      return (await runs(scriptId)).find((item) => !previous.has(item.id))!
    }
    const query = (url: string) => page.evaluate(async (url) => { const result = await window.octo.captureQuery({ url }); if (!result.ok) throw new Error(result.error); return result.data }, url)
    const browserOptions = browserOptionsSchema.parse({ proxy: { server: `http://127.0.0.1:${upstream.port}` } })
    await command(page, { type: 'site.save', draft: { name: '另一网站', url: 'http://same.example/other', captureEnabled: true, browserOptions } })
    const other = (await state(page)).config.sites[0]
    await command(page, { type: 'browser.start', siteId: other.id })
    await expect.poll(async () => (await query('/other')).items.length).toBeGreaterThan(0)
    const otherRecord = (await query('/other')).items[0]
    const injection = await save('抓包注入验证', 'injection', `const own = await octo.capture.query({url:'/other'}); let denied=false; try { await octo.capture.get(${JSON.stringify(otherRecord.id)}); } catch { denied=true; } octo.log(JSON.stringify({count:own.items.length,denied,status:await octo.capture.status()}));`)
    await command(page, { type: 'capture.grant', scriptId: injection.id, grant: 'read' })
    await command(page, { type: 'site.save', draft: { name: '本网站', url: 'http://same.example/own', captureEnabled: true, browserOptions, injections: [{ scriptId: injection.id, enabled: true, values: {} }] } })
    const site = (await state(page)).config.sites.find((item) => item.name === '本网站')!
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(async () => (await runs(injection.id)).flatMap((run) => run.logs.map((log) => log.text)).join('\n')).toContain('"count":0')
    expect((await runs(injection.id)).flatMap((run) => run.logs.map((log) => log.text)).join('\n')).toContain('"denied":true')
    const action = await save('抓包行动验证', 'action', `const own = await octo.capture.query({url:'/own'}); const detail=await octo.capture.get(own.items[0].id); let denied=false; try {await octo.capture.query({siteId:${JSON.stringify(other.id)}});} catch {denied=true;} return {ids:own.items.map(item=>item.source.siteId),body:detail.response.body.text,denied};`)
    expect((await run(action.id, site.id)).error).toContain('授权')
    await page.getByRole('button', { name: /脚本能力/ }).click()
    await page.getByRole('row').filter({ hasText: '抓包行动验证' }).getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('combobox', { name: '抓包访问授权' }).click()
    await page.getByText('读取抓包', { exact: true }).click()
    await expect.poll(async () => (await state(page)).config.capture.grants[action.id]).toBe('read')
    await page.getByRole('button', { name: /^取\s*消$/ }).click()
    const actionRun = await run(action.id, site.id)
    expect(actionRun.status, actionRun.error).toBe('success')
    expect(JSON.parse(actionRun.result!)).toMatchObject({ ids: [site.id], denied: true })
    expect(JSON.parse(actionRun.result!).body).toContain('capture-product-ok')
    await command(page, { type: 'capture.grant', scriptId: action.id, grant: 'none' })
    expect((await run(action.id, site.id)).error).toContain('授权')
    await proxyRequest(port, `http://127.0.0.1:${upstream.port}/external-api`)
    const sandbox = await save('抓包沙箱验证', 'sandbox', `const records=await octo.capture.query(); let blocked=false; try {await octo.capture.stop();} catch {blocked=true;} return {sources:[...new Set(records.items.map(item=>item.source.siteId||'external'))],blocked};`)
    await command(page, { type: 'capture.grant', scriptId: sandbox.id, grant: 'control' })
    const sandboxRun = await run(sandbox.id)
    expect(sandboxRun.status, sandboxRun.error).toBe('success')
    expect(JSON.parse(sandboxRun.result!).sources.sort()).toEqual([site.id, other.id, 'external'].sort())
    expect(JSON.parse(sandboxRun.result!).blocked).toBe(true)
    const tokens: Record<string, string> = {}
    for (const level of ['read', 'operate', 'full'] as const) {
      const reply = await page.evaluate((level) => window.octo.secret({ type: 'create', draft: { alias: level, level } }), level)
      if (!reply.ok) throw new Error(reply.error)
      tokens[level] = reply.data.secret
    }
    const mcpPort = await freePort()
    await command(page, { type: 'mcp.save', settings: { enabled: true, port: mcpPort } })
    const call = async (level: string, name: string, args: object = {}) => {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { 'authorization': `Bearer ${tokens[level]}`, 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      return (await response.json() as { result: { isError?: boolean; content: { text: string }[] } }).result
    }
    for (const level of ['read', 'operate', 'full']) {
      const result = await call(level, 'capture_status')
      expect(result.isError).toBeFalsy(); expect(Object.keys(JSON.parse(result.content[0].text)).sort()).toEqual(['allowed', 'pending', 'port', 'status'])
      for (const name of ['capture_requests', 'capture_detail', 'capture_start', 'capture_stop']) expect((await call(level, name, name === 'capture_detail' ? { id: otherRecord.id } : {})).isError).toBe(true)
    }
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port, allowScripts: true, allowMcp: true }) })
    expect((await call('read', 'capture_requests')).isError).toBe(true)
    expect((await call('operate', 'capture_detail', { id: otherRecord.id })).isError).toBe(true)
    expect((await call('full', 'capture_requests')).isError).toBeFalsy()
    expect((await call('full', 'capture_detail', { id: otherRecord.id })).isError).toBeFalsy()
    expect((await call('full', 'capture_start')).isError).toBeFalsy()
    expect((await call('full', 'capture_stop')).isError).toBe(true)
    await command(page, { type: 'browser.stop', siteId: site.id }); await command(page, { type: 'browser.stop', siteId: other.id })
    expect((await call('full', 'capture_stop')).isError).toBeFalsy()
  } finally {
    try { if (process.env.OCTO_TEST_TRACE) await application.context().tracing.stop({ path: test.info().outputPath('electron-trace.zip') }) } finally { await stopAll(application, page); upstream.server.closeAllConnections(); upstream.server.close() }
  }
})

test('隔离工作台规则、HAR 导入导出与保存确认', async () => {
  const desktop = await launchDesktop(), { page, application } = desktop, upstream = await proxyFixture()
  try {
    const port = await freePort()
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port }) })
    await command(page, { type: 'capture.start' })
    await page.getByRole('button', { name: /抓包调试/ }).click()
    await expect.poll(() => application.context().pages().some((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()))).toBe(true)
    const workbench = application.context().pages().find((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()))!
    await expect(workbench.locator('.w-network-menu:visible')).toBeVisible()
    const rules = [
      `mapping.test host://127.0.0.1:${upstream.port}`,
      'mapping.test/rewrite reqHeaders://{capture-headers} resBody://(rewritten-body)',
      'mock.test statusCode://201 resBody://(mock-body)',
      'mapping.test/delay resDelay://250',
      'mapping.test/slow resSpeed://32'
    ].join('\n')
    const setRule = await workbench.evaluate(async (value) => {
      const post = (route: string, body: object) => fetch(`/cgi-bin/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((res) => res.json())
      await post('values/add', { name: 'capture-headers', value: JSON.stringify({ 'x-capture-test': 'changed' }) })
      return post('rules/add', { name: 'capture-acceptance', value, selected: true })
    }, rules)
    expect(setRule.ec).toBe(0)
    expect(await proxyRequest(port, 'http://mapping.test/original')).toContain('capture-product-ok')
    expect(await proxyRequest(port, 'http://mapping.test/rewrite')).toBe('rewritten-body')
    expect(upstream.received.find((item) => item.url === '/rewrite')?.marker).toBe('changed')
    expect(await proxyRequest(port, 'http://mock.test/mock')).toBe('mock-body')
    const delayed = Date.now()
    await proxyRequest(port, 'http://mapping.test/delay')
    expect(Date.now() - delayed).toBeGreaterThanOrEqual(230)
    const throttled = Date.now()
    expect((await proxyRequest(port, 'http://mapping.test/slow')).length).toBe(4096)
    expect(Date.now() - throttled).toBeGreaterThanOrEqual(700)
    const filter = workbench.getByPlaceholder('Type filter text', { exact: true }).filter({ visible: true })
    await filter.pressSequentially('mapping.test')
    await expect(filter).toHaveValue('mapping.test')
    await expect(workbench.locator('body')).toContainText('/rewrite')
    await filter.press('ControlOrMeta+A'); await filter.press('Backspace')
    await expect(filter).toHaveValue('')
    await expect(workbench.locator('body')).toContainText('/mock')
    await workbench.getByText('Export', { exact: true }).filter({ visible: true }).click()
    await workbench.locator('select:has(option[value="har"]):visible').selectOption('har')
    const exported = path.join(desktop.dataDir, 'workbench.har')
    await expect(stat(exported)).rejects.toThrow()
    await application.evaluate(({ dialog, BrowserWindow, WebContentsView }, filePath) => {
      const probe = { prompted: 0, visible: true, finished: '', cancelNext: false }
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child instanceof WebContentsView) as Electron.WebContentsView
      dialog.showSaveDialogSync = () => {
        probe.prompted++; probe.visible = view.getVisible()
        return probe.cancelNext ? '' : filePath
      }
      view.webContents.session.prependListener('will-download', (_event: Electron.Event, item: Electron.DownloadItem) => { item.once('done', (_event, status) => { probe.finished = status }) })
      Object.assign(globalThis, { downloadProbe: probe })
    }, exported)
    const prompt = () => application.evaluate(() => {
      const probe = (globalThis as unknown as { downloadProbe: { prompted: number; visible: boolean; finished: string } }).downloadProbe
      return { prompted: probe.prompted, visible: probe.visible, finished: probe.finished }
    })
    await workbench.getByRole('button', { name: 'Export All', exact: true }).click()
    await expect.poll(async () => (await prompt()).prompted).toBe(1)
    expect((await prompt()).visible).toBe(false)
    await expect.poll(async () => (await prompt()).finished).toBe('completed')
    const har = JSON.parse(await readFile(exported, 'utf8'))
    expect(har.log.version).toBe('1.2')
    expect(har.log.entries.some((entry: { request: { url: string }; response: { content: { text: string } } }) => entry.request.url === 'http://mapping.test/rewrite' && entry.response.content.text === 'rewritten-body')).toBe(true)
    await application.evaluate(() => { (globalThis as unknown as { downloadProbe: { cancelNext: boolean } }).downloadProbe.cancelNext = true })
    await workbench.getByText('Export', { exact: true }).filter({ visible: true }).click()
    await workbench.getByRole('button', { name: 'Export All', exact: true }).click()
    await expect.poll(async () => (await prompt()).prompted).toBe(2)
    await expect.poll(async () => (await prompt()).finished).toBe('cancelled')
    har.log.entries = [har.log.entries.find((entry: { request: { url: string } }) => entry.request.url === 'http://mapping.test/rewrite')]
    har.log.entries[0].request.url = 'http://mapping.test/har-imported'
    await workbench.getByText('Import', { exact: true }).filter({ visible: true }).first().click()
    const [choosing] = await Promise.all([workbench.waitForEvent('filechooser'), workbench.getByRole('button', { name: /Upload$/ }).click()])
    await choosing.setFiles({ name: 'imported.har', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(har)) })
    await expect(workbench.locator('body')).toContainText('/har-imported')
  } finally { await stopAll(application, page); upstream.server.closeAllConnections(); upstream.server.close() }
})

test('上游凭据运行快照、认证失败不直连和 SOCKS5 串联', async () => {
  const desktop = await launchDesktop(), { page, application } = desktop
  if (process.env.OCTO_TEST_TRACE) await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  const credentials = { username: 'snapshot', password: 'original-password' }
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
  const upstream = await proxyFixture(authorization), target = await proxyFixture()
  const sockets = new Set<Socket>(), destinations: string[] = []
  const socks = createRequire(path.join(process.cwd(), 'package.json'))('sockx') as {
    createServer(listener: (info: { dstAddr: string; dstPort: number }, accept: (intercept: boolean) => Socket | undefined) => void): NetServer & { useAuth(auth: unknown): void }
    auth: { None(): unknown }
  }
  const socksServer = socks.createServer((info, accept) => {
    destinations.push(`${info.dstAddr}:${info.dstPort}`)
    const client = accept(true)
    if (!client) return
    const remote = connect(target.port, '127.0.0.1')
    client.pipe(remote); remote.pipe(client)
    for (const socket of [client, remote]) { sockets.add(socket); socket.on('close', () => { sockets.delete(socket); client.destroy(); remote.destroy() }); socket.on('error', () => { client.destroy(); remote.destroy() }) }
  })
  socksServer.useAuth(socks.auth.None())
  await new Promise<void>((resolve) => socksServer.listen(0, '127.0.0.1', resolve))
  try {
    const port = await freePort()
    const settings = captureSettingsSchema.parse({ port, upstream: { server: `http://127.0.0.1:${upstream.port}` } })
    await command(page, { type: 'capture.save', settings, credentials }); await command(page, { type: 'capture.start' })
    const url = `http://127.0.0.1:${target.port}/snapshot`
    expect(await proxyRequest(port, url)).toContain('capture-product-ok')
    await command(page, { type: 'capture.save', settings, credentials: { ...credentials, password: 'rotated-password' } })
    expect((await state(page)).capture.pending).toBe(true)
    expect(await proxyRequest(port, `${url}-old`)).toContain('capture-product-ok')
    expect(upstream.received.filter((item) => item.url?.includes('/snapshot')).map((item) => item.auth)).toEqual([authorization, authorization])
    await command(page, { type: 'capture.restart' })
    expect(await proxyRequest(port, `${url}-denied`)).not.toContain('capture-product-ok')
    const failure = await page.evaluate(async () => {
      const query = await window.octo.captureQuery({ url: '/snapshot-denied' }); if (!query.ok) throw new Error(query.error)
      const result = await window.octo.captureDetail(query.data.items[0].id); if (!result.ok) throw new Error(result.error)
      return result.data
    })
    expect(failure.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(failure)).not.toMatch(/original-password|rotated-password|proxy-authorization/i)
    expect(target.received).toEqual([])
    await command(page, { type: 'capture.stop' })
    const socksPort = (socksServer.address() as { port: number }).port
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port, upstream: { server: `socks5://127.0.0.1:${socksPort}` } }), credentials: null })
    await command(page, { type: 'capture.start' })
    expect(await proxyRequest(port, 'http://same.example/socks')).toContain('capture-product-ok')
    expect(destinations).toContain('same.example:80')
    expect(target.received.find((item) => item.url === '/socks')?.auth).toBeUndefined()
    await command(page, { type: 'capture.stop' })
    upstream.server.closeAllConnections(); await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
    await command(page, { type: 'capture.save', settings, credentials }); await command(page, { type: 'capture.start' })
    try { expect(await proxyRequest(port, `${url}-unreachable`)).not.toContain('capture-product-ok') } catch (error) {
      if (process.env.OCTO_TEST_TRACE) {
        const diagnostic = await page.evaluate(async () => {
          const query = await window.octo.captureQuery({ url: '/snapshot-unreachable' })
          return { query, details: query.ok ? await Promise.all(query.data.items.map((item) => window.octo.captureDetail(item.id))) : [] }
        })
        await test.info().attach('不可达上游抓包记录', { body: JSON.stringify(diagnostic), contentType: 'application/json' })
      }
      throw error
    }
    expect(target.received.filter((item) => item.url?.includes('/snapshot'))).toEqual([])
  } finally {
    try { if (process.env.OCTO_TEST_TRACE) await application.context().tracing.stop({ path: test.info().outputPath('electron-trace.zip') }) } finally {
      await stopAll(application, page)
      for (const socket of sockets) socket.destroy()
      socksServer.close(); upstream.server.closeAllConnections(); upstream.server.close(); target.server.closeAllConnections(); target.server.close()
    }
  }
})

async function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false)); socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
  })
}

test('真实抓包子进程崩溃、关联网站告警与应用退出无残留监听', async () => {
  const desktop = await launchDesktop(), { page, application } = desktop, upstream = await proxyFixture()
  let closed = false
  try {
    const port = await freePort()
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port }) }); await command(page, { type: 'capture.start' })
    await page.getByRole('button', { name: /抓包调试/ }).click()
    await expect.poll(() => application.context().pages().some((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()))).toBe(true)
    const uiPort = Number(new URL(application.context().pages().find((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()))!.url()).port)
    await command(page, { type: 'site.save', draft: { name: '崩溃验收', url: 'http://same.example/crash', captureEnabled: true, browserOptions: browserOptionsSchema.parse({ proxy: { server: `http://127.0.0.1:${upstream.port}` } }) } })
    const site = (await state(page)).config.sites[0]
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(() => upstream.received.some((item) => item.url?.includes('/crash'))).toBe(true)
    await application.evaluate(({ app }) => {
      const child = app.getAppMetrics().find((item) => item.name === 'Octo Fetch 抓包代理')
      if (!child || child.type !== 'Utility') throw new Error('找不到测试应用的抓包子进程')
      process.kill(child.pid, 'SIGKILL')
    })
    await expect.poll(async () => (await state(page)).capture.status).toBe('error')
    expect((await state(page)).runtimes[0]).toMatchObject({ captureActive: false, captureError: true, warning: expect.stringContaining('不会自动改为直连') })
    await expect.poll(() => listening(port)).toBe(false); await expect.poll(() => listening(uiPort)).toBe(false)
    await expect(command(page, { type: 'capture.start' })).rejects.toThrow('受影响')
    await command(page, { type: 'browser.stop', siteId: site.id }); await command(page, { type: 'capture.start' })
    await command(page, { type: 'browser.start', siteId: site.id })
    expect((await state(page)).runtimes[0].captureActive).toBe(true)
    await expect.poll(() => application.context().pages().some((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()))).toBe(true)
    const restartedUi = Number(new URL(application.context().pages().find((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()))!.url()).port)
    await application.close(); closed = true
    await expect.poll(() => listening(port)).toBe(false); await expect.poll(() => listening(restartedUi)).toBe(false)
  } finally { if (!closed) await stopAll(application, page); upstream.server.closeAllConnections(); upstream.server.close() }
})

test('真实引擎压缩、重复 Header、二进制及缺失大正文语义', async () => {
  const desktop = await launchDesktop(), { page, application } = desktop, upstream = await proxyFixture()
  try {
    const port = await freePort()
    await command(page, { type: 'capture.save', settings: captureSettingsSchema.parse({ port }) }); await command(page, { type: 'capture.start' })
    for (const route of ['/compressed', '/binary', '/oversized', '/bad-gzip', '/corrupt-gzip', '/redirect']) {
      await proxyRequest(port, `http://127.0.0.1:${upstream.port}${route}`)
      const readDetail = () => page.evaluate(async (url) => {
        const query = await window.octo.captureQuery({ url }); if (!query.ok) throw new Error(query.error)
        if (!query.data.items.length) return undefined
        const result = await window.octo.captureDetail(query.data.items[0].id); if (!result.ok) throw new Error(result.error)
        return result.data
      }, route)
      // 客户端收完响应时，引擎仍可能正在异步解压并更新缓存。
      await expect.poll(async () => Boolean((await readDetail())?.endedAt), { message: `${route} 引擎正文处理完成` }).toBe(true)
      const detail = (await readDetail())!
      if (route === '/compressed') {
        expect(detail.response.body).toMatchObject({ text: '压缩正文'.repeat(100), contentEncoding: 'gzip', decoded: true, truncated: false, unavailable: false })
        expect(detail.response.headers.filter((h) => h.name === 'set-cookie').map((h) => h.value)).toEqual(['a=1', 'b=2'])
      } else if (route === '/binary') {
        expect(detail.response.body).toMatchObject({ base64: 'AP+AAQ==', truncated: false, unavailable: false })
      } else if (route === '/bad-gzip') {
        expect(detail.response.body).toMatchObject({ decoded: false, truncated: false, unavailable: false, base64: Buffer.from('invalid gzip').toString('base64') })
      } else if (route === '/redirect') {
        expect(detail).toMatchObject({ status: 302, response: { headers: expect.arrayContaining([{ name: 'location', value: '/binary' }]) } })
      } else {
        expect(detail.response.body).toMatchObject({ truncated: true, unavailable: true })
      }
    }
    const streaming = proxyRequest(port, `http://127.0.0.1:${upstream.port}/stream`)
    void streaming.catch(() => undefined)
    const streamBody = () => page.evaluate(async () => {
      const query = await window.octo.captureQuery({ url: '/stream' }); if (!query.ok || !query.data.items.length) return undefined
      const result = await window.octo.captureDetail(query.data.items[0].id); if (!result.ok) throw new Error(result.error)
      return result.data.response.body
    })
    await expect.poll(async () => (await streamBody())?.pending).toBe(true)
    expect((await streamBody())?.truncated).toBe(true)
    upstream.finishStream()
    expect(await streaming).toBe('开始结束')
    await expect.poll(streamBody).toMatchObject({ pending: false, truncated: false, unavailable: false, text: '开始结束' })
  } finally { await stopAll(application, page); upstream.server.closeAllConnections(); upstream.server.close() }
})
