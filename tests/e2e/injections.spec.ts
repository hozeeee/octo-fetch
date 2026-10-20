import type { Page } from '@playwright/test'
import type { ScriptDraft } from '../../src/shared/scripts'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { scriptDraftSchema } from '../../src/shared/scripts'
import { addSite, command, launchDesktop, state, stopAll } from './helpers'

async function networkSite() {
  const received: { path: string; method: string; body: string; header?: string; cookie?: string }[] = []
  let documents = 0
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = { path: req.url, method: req.method!, body: Buffer.concat(chunks).toString(), header: req.headers['x-octo-test'] as string | undefined, cookie: req.headers.cookie }
      received.push(request)
      const body = gzipSync(JSON.stringify({ original: true, sequence: received.length, request }))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Set-Cookie': ['first=1; Path=/', 'second=2; Path=/'] })
      res.end(body); return
    }
    documents++
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`<html><head><title>注入验证站</title></head><body><pre id="result"></pre><script>
      fetch('/api/original', {method:'POST',body:'original'}).then(r=>r.json()).then(data=>document.querySelector('#result').textContent=JSON.stringify({...data, cookie:document.cookie, boot:window.boot}));
    </script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { received, documents: () => documents, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
async function runs(page: Page, id: string) {
  return page.evaluate(async (id) => { const reply = await window.octo.scriptRuns(id); if (!reply.ok) throw new Error(reply.error); return reply.data }, id)
}
async function save(page: Page, draft: ScriptDraft, id?: string) {
  await command(page, { type: 'script.save', draft, id })
  return (await state(page)).scripts.find((script) => script.id === id || (!id && script.draft.name === draft.name))!
}
async function target(page: Page, siteId: string) {
  const runtime = (await state(page)).runtimes.find((runtime) => runtime.siteId === siteId)!
  return { siteId, generation: runtime.generation, tabId: runtime.activeTabId! }
}
async function result(page: Page, scriptId: string, siteId: string) {
  await expect.poll(async () => {
    const runtime = (await state(page)).runtimes.find((item) => item.siteId === siteId)
    return runtime?.tabs.find((tab) => tab.id === runtime.activeTabId)?.url
  }).toMatch(/^http:\/\/127\.0\.0\.1:/)
  await command(page, { type: 'script.run', scriptId, siteId, values: {} })
  await expect.poll(async () => (await runs(page, scriptId))[0]?.status).toBe('success')
  return JSON.parse((await runs(page, scriptId))[0].result!)
}
async function source(page: Page, value: string) {
  await page.getByTestId('script-code-editor').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(value)
}
const readDraft = scriptDraftSchema.parse({ name: '读取接口结果', match: ['127.0.0.1'], source: 'await page.waitForFunction(() => document.querySelector(\'#result\')?.textContent); return page.$eval(\'#result\', el => JSON.parse(el.textContent));' })
const sourceFor = (version: number) => `
const digest = require('node:crypto').createHash('sha256').update('injection').digest('hex');
const { basename } = await import('node:path');
console.log('Node 能力', typeof process, digest.length, basename('/tmp/injection.js'));
await page.evaluateOnNewDocument(() => { window.boot = true; });
const removed = () => console.log('不应出现的监听');
page.on('domcontentloaded', removed); page.off('domcontentloaded', removed);
page.on('domcontentloaded', () => console.log('页面完成'));
octo.onDispose(() => console.log('标签清理'));
octo.interceptRequest({urlPattern:'*/api/*'}, request => ({
  url: request.url.replace('/api/original', '/api/changed'),
  headers: [...request.headers, {name:'X-Octo-Test',value:octo.vars.account}],
  postData: 'changed-' + octo.vars.account
}));
octo.interceptResponse({urlPattern:'*/api/*'}, ({response}) => ({body:JSON.stringify({...JSON.parse(response.body), injected:octo.vars.account, version:${version}})}));
return;
`

test('离线 Monaco、网站参数绑定、真实改写、账号隔离和重启快照', async () => {
  const website = await networkSite()
  let desktop = await launchDesktop()
  try {
    const { page } = desktop
    const workers: string[] = [], errors: string[] = []
    page.on('worker', (worker) => workers.push(worker.url()))
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(/^https?:/, (route) => route.abort())
    const a = await addSite(page, '注入账号 A', website.origin)
    const b = await addSite(page, '注入账号 B', website.origin)
    await page.getByRole('button', { name: /脚本能力/ }).click()
    await page.getByText('注入', { exact: true }).click()
    await page.getByRole('button', { name: '新建脚本', exact: true }).click()
    await page.getByLabel('脚本名称', { exact: true }).fill('真实接口改写')
    await page.getByLabel('适用域名', { exact: true }).fill('127.0.0.1')
    await page.getByLabel('适用域名', { exact: true }).press('Enter')
    await page.getByRole('button', { name: '添加变量', exact: true }).click()
    await page.getByLabel('变量名', { exact: true }).fill('account')
    await page.getByLabel('显示名称', { exact: true }).fill('账号标识')
    await page.getByLabel('默认值', { exact: true }).fill('default')
    await source(page, 'const = ;')
    await expect(page.locator('.squiggly-error').first()).toBeVisible()
    await source(page, sourceFor(1))
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
    expect(workers.some((url) => /ts.worker/.test(url))).toBe(true)
    expect(workers.every((url) => !/^https?:/.test(url))).toBe(true)
    expect(errors).toEqual([])
    await page.getByRole('button', { name: '保存脚本', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    const injection = (await state(page)).scripts.find((item) => item.draft.name === '真实接口改写')!
    expect(injection.draft.kind).toBe('injection')
    await page.getByRole('button', { name: /页面管理/ }).click()
    await page.getByRole('row').filter({ hasText: '注入账号 A' }).getByRole('button', { name: '编辑配置' }).click()
    await page.getByRole('button', { name: '添加注入', exact: true }).click()
    await page.getByLabel('注入脚本 1', { exact: true }).click()
    await page.getByText('真实接口改写', { exact: true }).click()
    await page.getByLabel('账号标识', { exact: true }).fill('A')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    expect((await state(page)).config.sites.find((site) => site.id === a.id)?.injections[0].values).toEqual({ account: 'A' })
    await command(page, { type: 'site.save', id: b.id, draft: { name: b.name, url: b.url, injections: [{ scriptId: injection.id, enabled: true, values: { account: 'B' } }] } })
    const action = await save(page, readDraft)
    await command(page, { type: 'browser.start', siteId: a.id })
    await command(page, { type: 'browser.start', siteId: b.id })
    const initial = await result(page, action.id, a.id)
    expect(initial).toMatchObject({ original: true, injected: 'A', version: 1, boot: true, request: { path: '/api/changed', body: 'changed-A', method: 'POST', header: 'A' } })
    expect(initial.cookie).toContain('first=1'); expect(initial.cookie).toContain('second=2')
    expect(await result(page, action.id, b.id)).toMatchObject({ injected: 'B', version: 1 })
    expect(website.received).toHaveLength(2)
    expect((await runs(page, injection.id)).every((run) => run.kind === 'injection' && run.phase === 'active')).toBe(true)
    await command(page, { type: 'tab.reload', ...await target(page, a.id) })
    expect(await result(page, action.id, a.id)).toMatchObject({ injected: 'A', version: 1 })
    expect((await runs(page, injection.id)).find((run) => run.siteId === a.id)!.logs.filter((log) => log.text === '注入已生效')).toHaveLength(1)
    expect((await runs(page, injection.id)).flatMap((run) => run.logs).some((log) => log.text === 'Node 能力 object 64 injection.js')).toBe(true)
    expect((await runs(page, injection.id)).flatMap((run) => run.logs).some((log) => log.text === '不应出现的监听')).toBe(false)
    const loaded = await page.evaluate((id) => window.octo.script(id), injection.id)
    if (!loaded.ok) throw new Error(loaded.error)
    await save(page, { ...loaded.data.draft, source: sourceFor(2) }, injection.id)
    expect((await state(page)).runtimes.every((runtime) => runtime.injectionsPending)).toBe(true)
    await expect(page.getByText('待重启生效', { exact: true }).first()).toBeVisible()
    await command(page, { type: 'tab.new', siteId: a.id })
    const newTarget = await target(page, a.id)
    await command(page, { type: 'tab.navigate', ...newTarget, url: website.origin })
    expect(await result(page, action.id, a.id)).toMatchObject({ injected: 'A', version: 1 })
    await command(page, { type: 'tab.close', ...newTarget })
    await expect.poll(async () => (await runs(page, injection.id)).find((run) => run.siteId === a.id)?.logs.some((log) => log.tabId === newTarget.tabId && log.text === '标签清理')).toBe(true)
    await command(page, { type: 'browser.stop', siteId: a.id })
    await command(page, { type: 'browser.start', siteId: a.id })
    expect(await result(page, action.id, a.id)).toMatchObject({ injected: 'A', version: 2 })
    expect(await result(page, action.id, b.id)).toMatchObject({ injected: 'B', version: 1 })
    await command(page, { type: 'site.save', id: a.id, draft: { name: a.name, url: a.url, injections: [{ scriptId: injection.id, enabled: false, values: { account: 'A' } }] } })
    await command(page, { type: 'browser.stop', siteId: a.id })
    await command(page, { type: 'browser.start', siteId: a.id })
    const disabled = await result(page, action.id, a.id)
    expect(disabled).not.toHaveProperty('injected')
    expect(disabled.request).toMatchObject({ path: '/api/original', body: 'original' })
    expect(disabled.cookie).toContain('first=1')
    const dataDir = desktop.dataDir
    await stopAll(desktop.application, page)
    desktop = await launchDesktop(dataDir)
    expect((await runs(desktop.page, injection.id)).every((run) => run.phase === 'stopped')).toBe(true)
    await command(desktop.page, { type: 'browser.start', siteId: a.id })
    expect(await result(desktop.page, action.id, a.id)).not.toHaveProperty('injected')
  } finally { await stopAll(desktop.application, desktop.page).catch(() => undefined); await website.close() }
})

test('未主动指定的注入不执行，域名匹配不自动绑定或跨网站生效', async () => {
  const website = await networkSite(), desktop = await launchDesktop()
  const { page } = desktop
  try {
    const existing = await addSite(page, '已有未绑定网站', website.origin)
    await command(page, { type: 'browser.start', siteId: existing.id })
    const injection = await save(page, scriptDraftSchema.parse({
      kind: 'injection', name: '必须主动指定', match: ['127.0.0.1'], source: sourceFor(1),
      variables: [{ key: 'account', label: '账号标识', kind: 'text', default: 'chosen' }]
    }))
    const unused = await save(page, scriptDraftSchema.parse({ kind: 'injection', name: '匹配但未指定', match: ['127.0.0.1'], source: 'throw new Error(\'未指定的脚本不应执行\');' }))
    const fresh = await addSite(page, '新建未绑定网站', website.origin)
    const action = await save(page, readDraft)
    const assertUnmodified = async (siteId: string) => {
      const data = await result(page, action.id, siteId)
      expect(data).toMatchObject({ original: true, request: { path: '/api/original', body: 'original' } })
      expect(data).not.toHaveProperty('injected')
      expect(data).not.toHaveProperty('boot')
      const snapshot = await state(page)
      expect(snapshot.config.sites.find((site) => site.id === siteId)?.injections).toEqual([])
      expect(snapshot.runtimes.find((runtime) => runtime.siteId === siteId)?.injections || []).toEqual([])
    }
    await assertUnmodified(existing.id)
    await command(page, { type: 'tab.reload', ...await target(page, existing.id) })
    await assertUnmodified(existing.id)
    await command(page, { type: 'browser.start', siteId: fresh.id })
    await assertUnmodified(fresh.id)
    await command(page, { type: 'tab.new', siteId: existing.id })
    await command(page, { type: 'tab.navigate', ...await target(page, existing.id), url: website.origin })
    await assertUnmodified(existing.id)
    await command(page, { type: 'browser.stop', siteId: existing.id })
    await command(page, { type: 'browser.start', siteId: existing.id })
    await assertUnmodified(existing.id)
    expect(await runs(page, injection.id)).toEqual([])
    expect(await runs(page, unused.id)).toEqual([])
    await page.getByRole('button', { name: /页面管理/ }).click()
    await page.getByRole('row').filter({ hasText: fresh.name }).getByRole('button', { name: '编辑配置' }).click()
    await expect(page.getByLabel('注入脚本 1', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '添加注入', exact: true }).click()
    await page.getByLabel('注入脚本 1', { exact: true }).click()
    await page.getByText('必须主动指定', { exact: true }).click()
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await command(page, { type: 'browser.stop', siteId: fresh.id })
    await command(page, { type: 'browser.start', siteId: fresh.id })
    expect(await result(page, action.id, fresh.id)).toMatchObject({ injected: 'chosen', version: 1, boot: true })
    await command(page, { type: 'tab.reload', ...await target(page, existing.id) })
    await assertUnmodified(existing.id)
    expect((await runs(page, injection.id)).map((run) => run.siteId)).toEqual([fresh.id])
    expect(await runs(page, unused.id)).toEqual([])
  } finally { await stopAll(desktop.application, page).catch(() => undefined); await website.close() }
})

test('初始化失败不导航，拦截异常原始放行，Worker 死循环停用后仍可操作', async () => {
  const website = await networkSite(), desktop = await launchDesktop()
  const { page } = desktop
  try {
    const site = await addSite(page, '故障注入', website.origin)
    const draft = scriptDraftSchema.parse({ kind: 'injection', name: '故障测试', match: ['127.0.0.1'], timeout: 1, source: 'await new Promise(() => {});' })
    const injection = await save(page, draft)
    await command(page, { type: 'site.save', id: site.id, draft: { name: site.name, url: site.url, injections: [{ scriptId: injection.id, enabled: true, values: {} }] } })
    await expect(command(page, { type: 'browser.start', siteId: site.id })).rejects.toThrow('注入')
    expect(website.received).toHaveLength(0)
    expect(website.documents()).toBe(0)
    expect((await runs(page, injection.id))[0].phase).toBe('disabled')
    await save(page, { ...draft, source: 'octo.interceptResponse({urlPattern:\'*/api/*\'}, () => { throw new Error(\'handler failed\'); });' }, injection.id)
    await command(page, { type: 'browser.start', siteId: site.id })
    const action = await save(page, readDraft)
    expect(await result(page, action.id, site.id)).toMatchObject({ original: true })
    await expect.poll(async () => (await state(page)).runtimes[0].injections?.[0].phase).toBe('disabled')
    await command(page, { type: 'tab.reload', ...await target(page, site.id) })
    expect(await result(page, action.id, site.id)).toMatchObject({ original: true })
    expect(website.received).toHaveLength(2)
    await command(page, { type: 'browser.stop', siteId: site.id })
    await save(page, { ...draft, source: 'octo.interceptRequest({urlPattern:\'*/api/*\'}, async () => { await Promise.resolve(); while(true) {} });' }, injection.id)
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(async () => (await state(page)).runtimes[0].injections?.[0].phase, { timeout: 20000 }).toBe('disabled')
    expect(await result(page, action.id, site.id)).toMatchObject({ original: true })
    expect((await state(page)).runtimes[0].status).toBe('running')
  } finally { await stopAll(desktop.application, page).catch(() => undefined); await website.close() }
})

test('绑定顺序与参数快照、弹窗纳管、运行引用限制和二级启动权限', async () => {
  const website = await networkSite(), desktop = await launchDesktop()
  const { page } = desktop
  try {
    const site = await addSite(page, '顺序与权限', website.origin)
    const ordered = (name: string) => scriptDraftSchema.parse({
      kind: 'injection', name, match: ['127.0.0.1'], timeout: 1,
      variables: [{ key: 'label', label: '标记', kind: 'text', required: true }],
      source: `console.log('初始化', octo.vars.label);
        octo.interceptResponse({urlPattern:'*/api/*'}, ({response}) => {
          const data = JSON.parse(response.body);
          return {body: JSON.stringify({...data, order: [...(data.order || []), octo.vars.label]})};
        });`
    })
    const first = await save(page, ordered('顺序一')), second = await save(page, ordered('顺序二'))
    const bind = (scriptId: string, label: string) => ({ scriptId, enabled: true, values: { label } })
    const saveBindings = (injections: ReturnType<typeof bind>[]) => command(page, { type: 'site.save', id: site.id, draft: { name: site.name, url: site.url, injections } })
    await saveBindings([bind(first.id, 'A'), bind(second.id, 'B')])
    const action = await save(page, readDraft)
    const token = await page.evaluate(() => window.octo.secret({ type: 'create', draft: { alias: '二级验证', level: 'operate' } }))
    if (!token.ok) throw new Error(token.error)
    const port = 48000 + Math.floor(Math.random() * 2000)
    await command(page, { type: 'mcp.save', settings: { enabled: true, port } })
    const rpc = async (name: string, args: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${token.data.secret}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      })
      return (await response.json() as { result: { isError?: boolean; content: { text: string }[] } }).result
    }
    for (const [name, args] of [
      ['save_site', { site_id: site.id, name: site.name, url: site.url, injections: [] }],
      ['save_script', { script_id: first.id, draft: ordered('越权') }],
      ['delete_script', { script_id: first.id }]
    ] as const) {
      const denied = await rpc(name, args)
      expect(denied.isError).toBe(true)
      expect(denied.content[0].text).toContain('三级')
    }
    expect((await rpc('start_site', { site_id: site.id })).isError).toBeFalsy()
    expect(await result(page, action.id, site.id)).toMatchObject({ order: ['A', 'B'] })
    await saveBindings([bind(second.id, 'B2'), bind(first.id, 'A2')])
    expect((await state(page)).runtimes[0].injectionsPending).toBe(true)
    await command(page, { type: 'tab.reload', ...await target(page, site.id) })
    expect(await result(page, action.id, site.id)).toMatchObject({ order: ['A', 'B'] })
    const popup = await save(page, { ...readDraft, name: '打开弹窗', source: 'await page.evaluate(() => { window.open(\'/popup\'); }); return true;' })
    await command(page, { type: 'script.run', scriptId: popup.id, siteId: site.id, values: {} })
    await expect.poll(async () => (await state(page)).runtimes[0].tabs.length).toBe(2)
    await expect.poll(async () => (await runs(page, first.id))[0].logs.filter((log) => log.text === '注入已生效').length).toBe(2)
    await expect.poll(async () => (await runs(page, second.id))[0].logs.filter((log) => log.text === '注入已生效').length).toBe(2)
    await expect.poll(async () => (await runs(page, popup.id))[0].status).toBe('success')
    await command(page, { type: 'tab.reload', ...await target(page, site.id) })
    expect(await result(page, action.id, site.id)).toMatchObject({ order: ['A', 'B'] })
    expect((await rpc('stop_site', { site_id: site.id })).isError).toBeFalsy()
    expect((await rpc('start_site', { site_id: site.id })).isError).toBeFalsy()
    expect(await result(page, action.id, site.id)).toMatchObject({ order: ['B2', 'A2'] })
    expect((await state(page)).runtimes[0].injectionsPending).toBe(false)
    await saveBindings([])
    // 删除先经过原生确认框；测试确认后继续验证运行引用限制。
    await desktop.application.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox })
    await expect(command(page, { type: 'script.delete', id: first.id })).rejects.toThrow('顺序与权限')
    await expect(save(page, { ...ordered('顺序一'), kind: 'action' }, first.id)).rejects.toThrow('顺序与权限')
    const close = await save(page, { ...readDraft, name: '模拟浏览器断开', source: 'await browser.close();' })
    await command(page, { type: 'script.run', scriptId: close.id, siteId: site.id, values: {} })
    await expect.poll(async () => (await state(page)).runtimes[0].status).toBe('error')
    await expect.poll(async () => (await state(page)).runtimes[0].injections || []).toEqual([])
    await expect.poll(async () => (await state(page)).scriptRuns.length).toBe(0)
    await command(page, { type: 'script.delete', id: first.id })
    await command(page, { type: 'script.delete', id: second.id })
    expect((await rpc('start_site', { site_id: site.id })).isError).toBeFalsy()
    expect(await result(page, action.id, site.id)).not.toHaveProperty('order')
    expect((await state(page)).runtimes[0].injectionsPending).toBe(false)
  } finally { await stopAll(desktop.application, page).catch(() => undefined); await website.close() }
})
