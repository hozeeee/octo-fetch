import type { Page } from '@playwright/test'
import type { ScriptDraft } from '../../src/shared/scripts'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { importScript } from '../../src/shared/scripts'
import { addSite, command, launchDesktop, state, stopAll, testSite } from './helpers'

async function runs(page: Page, id: string) {
  return page.evaluate(async (id) => { const reply = await window.octo.scriptRuns(id); if (!reply.ok) throw new Error(reply.error); return reply.data }, id)
}

test('手动创建、变量注入、多账号复用、导入导出与重启后日志恢复', async () => {
  const website = await testSite()
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined
  try {
    desktop = await launchDesktop()
    const { page, application, dataDir } = desktop
    const a = await addSite(page, '脚本账号 A', `${website.origin}/?client=a`)
    const b = await addSite(page, '脚本账号 B', `${website.origin}/?client=b`)
    await command(page, { type: 'browser.start', siteId: a.id })
    await command(page, { type: 'browser.start', siteId: b.id })
    await expect.poll(() => website.reports.size).toBe(2)
    await page.getByRole('button', { name: /脚本能力/ }).click()
    await page.getByRole('button', { name: '新建脚本', exact: true }).click()
    await page.getByLabel('脚本名称', { exact: true }).fill('通用输入能力')
    await page.getByLabel('适用域名', { exact: true }).fill('127.0.0.1')
    await page.getByLabel('适用域名', { exact: true }).press('Enter')
    await page.getByRole('button', { name: '添加变量', exact: true }).click()
    await page.getByLabel('变量名', { exact: true }).fill('query')
    await page.getByLabel('显示名称', { exact: true }).fill('搜索内容')
    await page.getByLabel('默认值', { exact: true }).fill('默认搜索')
    await page.getByTestId('script-code-editor').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(`
console.log('开始输入', octo.site.name);
await page.waitForSelector('#text');
await page.type('#text', octo.vars.query);
const value = await page.$eval('#text', element => element.value);
const digest = require('node:crypto').createHash('sha256').update(value).digest('hex');
const { basename } = await import('node:path');
return { value, siteName: octo.site.name, processType: typeof process, requireType: typeof require, digestLength: digest.length, basename: basename('/tmp/test.txt'), connected: browser.connected };
`)
    await page.getByRole('button', { name: '保存脚本', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    const row = page.getByRole('row').filter({ hasText: '通用输入能力' })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: /^运\s*行$/ }).click()
    await page.getByLabel('搜索内容', { exact: true }).fill('中文搜索 A')
    await page.getByRole('button', { name: '执行脚本', exact: true }).click()
    const script = (await state(page)).scripts.find((script) => script.draft.name === '通用输入能力')!
    await expect.poll(async () => (await runs(page, script.id))[0]?.status).toBe('success')
    const first = (await runs(page, script.id))[0]
    expect(JSON.parse(first.result!)).toMatchObject({ value: '中文搜索 A', siteName: '脚本账号 A', processType: 'object', requireType: 'function', digestLength: 64, basename: 'test.txt', connected: true })
    await expect(page.getByRole('log')).toContainText('开始输入')
    await page.screenshot({ path: 'test-results/script-logs.png' })
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await command(page, { type: 'script.run', scriptId: script.id, siteId: b.id, values: { query: '中文搜索 B' } })
    await expect.poll(async () => (await runs(page, script.id)).find((run) => run.siteId === b.id)?.status).toBe('success')
    await expect.poll(() => website.reports.get('b')?.text).toBe('中文搜索 B')
    expect(website.reports.get('a')?.text).toBe('中文搜索 A')
    const saved = await page.evaluate((id) => window.octo.script(id), script.id)
    expect(saved.ok && saved.data.values.query).toBe('中文搜索 B')

    const exported = path.join(dataDir, 'portable.js')
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog }, exported)
    await command(page, { type: 'script.export', id: script.id })
    const content = await readFile(exported, 'utf8')
    expect(importScript(content).name).toBe('通用输入能力')
    expect(content).not.toContain('中文搜索 B')
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, exported)
    await command(page, { type: 'script.import' })
    expect((await state(page)).scripts).toHaveLength(2)
    expect((await state(page)).scripts.some((item) => item.origin === 'import')).toBe(true)
    await expect(row).toHaveCount(2)
    await expect(row.filter({ hasText: '文件导入' })).toBeVisible()
    await page.screenshot({ path: 'test-results/scripts-library.png' })
    await stopAll(application, page)
    desktop = await launchDesktop(dataDir)
    expect((await state(desktop.page)).scripts).toHaveLength(2)
    expect(await runs(desktop.page, script.id)).toHaveLength(2)
    expect((await runs(desktop.page, script.id)).every((run) => run.status === 'success')).toBe(true)
  } finally {
    if (desktop) await stopAll(desktop.application, desktop.page).catch(() => undefined)
    await website.close()
  }
})

test('MCP 生成可见脚本，真实 Worker 取消、异步死循环超时与序列化错误', async () => {
  const website = await testSite()
  const desktop = await launchDesktop()
  const { page } = desktop
  try {
    const site = await addSite(page, 'MCP 测试网站', website.origin)
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(() => website.reports.size).toBe(1)
    const token = await page.evaluate(() => window.octo.secret({ type: 'create', draft: { alias: '测试 Agent', level: 'full' } }))
    if (!token.ok) throw new Error(token.error)
    const port = 45000 + Math.floor(Math.random() * 3000)
    await command(page, { type: 'mcp.save', settings: { enabled: true, port } })
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${token.data.secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      return await response.json() as { result: { instructions?: string; content: { text: string }[]; isError?: boolean } }
    }
    const call = async (name: string, args: unknown) => {
      const reply = await rpc('tools/call', { name, arguments: args })
      if (reply.result.isError) throw new Error(reply.result.content[0].text)
      return reply.result.content[0].text
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.result.instructions).toContain('save_script')
    expect(await call('script_guide', {})).toContain('octo.vars')
    const draft: ScriptDraft = { kind: 'action', name: 'Agent 等待能力', description: '验证中止', match: ['127.0.0.1'], variables: [], dependencies: [], timeout: 60, source: 'console.log(\'等待开始\'); await octo.sleep(30000); return 1;' }
    const { script_id } = JSON.parse(await call('save_script', { draft }))
    await page.getByRole('button', { name: /脚本能力/ }).click()
    await expect(page.getByRole('row').filter({ hasText: 'Agent 等待能力' })).toContainText('Agent 生成')
    const { run_id } = JSON.parse(await call('run_script', { script_id, site_id: site.id }))
    await expect.poll(async () => (await runs(page, script_id))[0]?.logs.some((log) => log.text === '等待开始')).toBe(true)
    await call('cancel_script_run', { run_id })
    expect((await runs(page, script_id))[0].status).toBe('cancelled')
    await call('save_script', { script_id, draft: { ...draft, timeout: 2, source: 'await Promise.resolve(); console.log("循环开始"); while (true) {}' } })
    await call('run_script', { script_id, site_id: site.id })
    await expect.poll(async () => (await runs(page, script_id))[0]?.logs.some((log) => log.text === '循环开始')).toBe(true)
    expect((await state(page)).scriptRuns).toHaveLength(1)
    await expect.poll(async () => (await runs(page, script_id))[0]?.status).toBe('timeout')
    await call('save_script', { script_id, draft: { ...draft, source: 'return { bad: 1n };' } })
    await call('run_script', { script_id, site_id: site.id })
    await expect.poll(async () => (await runs(page, script_id))[0]?.status).toBe('error')
    expect((await runs(page, script_id))[0].error).toContain('JSON')
    await call('save_script', { script_id, draft: { ...draft, match: ['other.example.com'] } })
    await expect(call('run_script', { script_id, site_id: site.id })).rejects.toThrow('不适用')
    expect((await state(page)).runtimes[0].status).toBe('running')
    await call('delete_script', { script_id })
    await expect.poll(async () => (await state(page)).scripts.length).toBe(0)
  } finally {
    await stopAll(desktop.application, page).catch(() => undefined)
    await website.close()
  }
})
