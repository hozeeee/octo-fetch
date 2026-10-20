import type { Page } from '@playwright/test'
import type { ScriptDraft, ScriptRun } from '../../src/shared/scripts'
import { readFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { importScript } from '../../src/shared/scripts'
import { command, launchDesktop, state } from './helpers'

const draft = (source: string, mode: 'once' | 'service' = 'once'): ScriptDraft => ({ kind: 'sandbox', dependencies: [], sandbox: { mode }, name: '沙箱验证', description: '', match: [], variables: [], timeout: 10, source })
async function runs(page: Page, id: string) {
  return page.evaluate(async (id) => { const reply = await window.octo.scriptRuns(id); if (!reply.ok) throw new Error(reply.error); return reply.data }, id)
}
async function save(page: Page, value: ScriptDraft) {
  await command(page, { type: 'script.save', draft: value })
  return (await state(page)).scripts[0]
}
async function terminal(page: Page, id: string): Promise<ScriptRun> {
  await expect.poll(async () => (await runs(page, id))[0]?.status).not.toBe('running')
  return (await runs(page, id))[0]
}
async function close(desktop: Awaited<ReturnType<typeof launchDesktop>>) {
  for (const run of (await state(desktop.page)).scriptRuns) await command(desktop.page, { type: 'script.cancel', id: run.id })
  await desktop.application.close()
}
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
const serverSource = `
const http = require('node:http');
const { once } = require('node:events');
const server = http.createServer((req, res) => { console.log('请求', req.url); res.end('沙箱响应'); });
octo.onDispose(() => new Promise(resolve => server.close(resolve)));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
return { port: server.address().port, pid: process.pid };
`

test('独立 Node.js 支持内置模块、动态导入、变量、输出和清理', async () => {
  const desktop = await launchDesktop()
  try {
    const script = await save(desktop.page, { ...draft(`
const fs = require('node:fs/promises');
const path = await import('node:path');
const crypto = require('crypto');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const child = spawn('/usr/bin/true', []);
await once(child, 'exit');
const worker = new Worker('require("node:worker_threads").parentPort.postMessage(42)', { eval: true });
const [workerValue] = await once(worker, 'message');
await worker.terminate();
await fs.writeFile('result.txt', String(octo.vars.number));
octo.onDispose(async () => { await fs.writeFile('disposed.txt', '清理完成'); console.log('清理日志'); });
console.log('计算日志');
process.stdout.write('无换行输出');
octo.output({ ignored: true });
return { value: Number(octo.vars.number) * 2, workerValue, file: await fs.readFile(path.join(process.cwd(), 'result.txt'), 'utf8'), uuid: crypto.randomUUID(), page: typeof page, browser: typeof browser, fetch: typeof fetch, buffer: Buffer.from('中文').length };
`), variables: [{ key: 'number', label: '数字', kind: 'number', required: true, default: 3 }] })
    await command(desktop.page, { type: 'script.run', scriptId: script.id, values: { number: 7 } })
    const run = await terminal(desktop.page, script.id)
    expect(run, JSON.stringify(run)).toMatchObject({ kind: 'sandbox', status: 'success', endReason: 'completed' })
    expect(run.siteId).toBeUndefined()
    expect(JSON.parse(run.result!)).toMatchObject({ value: 14, workerValue: 42, file: '7', page: 'undefined', browser: 'undefined', fetch: 'function', buffer: 6 })
    expect(run.logs.map((item) => item.text).join('\n')).toContain('计算日志')
    expect(run.logs.map((item) => item.text).join('\n')).toContain('无换行输出')
    expect(await readFile(path.join(desktop.dataDir, 'sandbox-data', script.id, 'disposed.txt'), 'utf8')).toBe('清理完成')
    expect((await state(desktop.page)).config.sites).toHaveLength(0)
  } finally { await close(desktop) }
})

test('界面创建一次性与 HTTP 常驻，参数配置、导出和重启恢复', async () => {
  let desktop = await launchDesktop()
  try {
    const { page, application, dataDir } = desktop
    await page.getByRole('button', { name: /脚本能力/ }).click()
    await page.locator('.ant-segmented-item').filter({ hasText: '沙箱' }).click()
    await page.getByRole('button', { name: '新建脚本', exact: true }).click()
    await page.getByLabel('脚本名称', { exact: true }).fill('参数计算')
    await expect(page.getByLabel('适用域名', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '添加变量', exact: true }).click()
    await page.getByLabel('变量名', { exact: true }).fill('input')
    await page.getByLabel('显示名称', { exact: true }).fill('计算入参')
    await page.getByTestId('script-code-editor').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText('console.log(\'收到入参\', octo.vars.input); return { length: octo.vars.input.length };')
    await page.getByRole('button', { name: '保存脚本', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    const row = page.getByRole('row').filter({ hasText: '参数计算' })
    await row.getByRole('button', { name: /^运\s*行$/ }).click()
    await expect(page.getByLabel('执行网站与标签')).toHaveCount(0)
    await page.getByLabel('计算入参', { exact: true }).fill('hello')
    await page.getByRole('button', { name: '执行脚本', exact: true }).click()
    await expect(page.getByRole('log')).toContainText('收到入参 hello')
    await expect(page.locator('.script-result')).toContainText('5')
    const once = (await state(page)).scripts.find((item) => item.draft.name === '参数计算')!
    await page.getByRole('dialog').press('Escape')
    await page.getByRole('button', { name: '新建脚本', exact: true }).click()
    await page.getByLabel('脚本名称', { exact: true }).fill('HTTP 服务')
    await page.getByLabel('运行模式', { exact: true }).click()
    await page.locator('.ant-select-item-option-content').getByText('常驻服务', { exact: true }).click()
    await expect(page.getByLabel('初始化超时（秒）')).toBeVisible()
    await expect(page.getByLabel('变量名', { exact: true })).toHaveCount(3)
    await page.getByRole('button', { name: '保存脚本', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    const serviceRow = page.getByRole('row').filter({ hasText: 'HTTP 服务' })
    await serviceRow.getByRole('button', { name: /^启\s*动$/ }).click()
    const port = await freePort()
    await page.getByLabel('端口', { exact: true }).fill(String(port))
    await page.getByLabel('响应内容', { exact: true }).fill('测试服务')
    await page.getByRole('button', { name: '启动服务', exact: true }).click()
    const service = (await state(page)).scripts.find((item) => item.draft.name === 'HTTP 服务')!
    await expect.poll(async () => (await runs(page, service.id))[0]?.phase).toBe('active')
    expect(await (await fetch(`http://127.0.0.1:${port}`)).json()).toEqual({ message: '测试服务' })
    await expect(page.getByRole('log')).toContainText('GET /')
    await expect(page.getByText('最新输出（非最终成功结果）', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/sandbox-service.png' })
    await page.getByRole('dialog').press('Escape')
    await expect(serviceRow.getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
    await serviceRow.getByRole('button', { name: /^停\s*止$/ }).click()
    await expect.poll(async () => (await runs(page, service.id))[0]?.status).toBe('cancelled')
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    const exported = path.join(dataDir, 'sandbox-export.js')
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog }, exported)
    await command(page, { type: 'script.export', id: service.id })
    const content = await readFile(exported, 'utf8')
    expect(content).toContain('"version":5')
    expect(importScript(content).sandbox?.mode).toBe('service')
    expect(content).not.toContain('测试服务')
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, exported)
    await command(page, { type: 'script.import' })
    expect((await state(page)).scripts.find((item) => item.origin === 'import')?.draft.sandbox?.mode).toBe('service')
    await close(desktop)
    desktop = await launchDesktop(dataDir)
    expect((await state(desktop.page)).scriptRuns).toHaveLength(0)
    expect((await runs(desktop.page, once.id))[0].result).toBe('{"length":5}')
    expect((await runs(desktop.page, service.id))[0].status).toBe('cancelled')
  } finally { await close(desktop) }
})

test('常驻日志滚动和快照更新，错误、超时及退出受控', async () => {
  const desktop = await launchDesktop()
  try {
    const { page } = desktop
    const cases = [
      { source: 'octo.output(1); throw new Error("同步异常")', status: 'error', error: '同步异常' },
      { source: 'return { value: 1n }', status: 'error', error: 'JSON' },
      { source: 'process.exit(0)', status: 'error', error: '意外退出' },
      { source: 'require("express")', status: 'error', error: 'Cannot find module' },
      { source: 'await import("express")', status: 'error', error: 'Cannot find module' },
      { source: 'Promise.reject(new Error("未处理拒绝")); await octo.sleep(1000)', status: 'error', error: '未处理拒绝' },
      { source: 'while (true) {}', status: 'timeout', error: '超时' }
    ]
    for (const item of cases) {
      const script = await save(page, { ...draft(item.source), timeout: 1 })
      await command(page, { type: 'script.run', scriptId: script.id, values: {} })
      const run = await terminal(page, script.id)
      expect(run.status, JSON.stringify(run)).toBe(item.status)
      expect(run.error).toContain(item.error)
      expect(run.result).toBeUndefined()
    }
    const script = await save(page, draft(`
let count = 0;
const timer = setInterval(() => { for (let i = 0; i < 50; i++) console.log('日志', ++count); octo.output({ count }); }, 600);
octo.onDispose(() => clearInterval(timer));
return { count };
`, 'service'))
    await command(page, { type: 'script.run', scriptId: script.id, values: {} })
    await expect.poll(async () => JSON.parse((await runs(page, script.id))[0]?.result || '{}').count).toBeGreaterThan(400)
    let run = (await runs(page, script.id))[0]
    expect(run.logs.length).toBeLessThanOrEqual(300)
    expect(run.droppedLogs).toBeGreaterThan(0)
    await command(page, { type: 'script.cancel', id: run.id })
    run = (await runs(page, script.id))[0]
    expect(run.status).toBe('cancelled')
    expect(JSON.parse(run.result!).count).toBeGreaterThan(400)
    for (const source of ['setTimeout(() => { throw new Error("异步异常") }, 100); return 1;', 'setTimeout(() => { while(true) {} }, 200); return 2;']) {
      const service = await save(page, draft(source, 'service'))
      await command(page, { type: 'script.run', scriptId: service.id, values: {} })
      if (source.includes('异步异常')) {
        const ended = await terminal(page, service.id)
        expect(ended.error).toContain('异步异常')
        expect(ended.result).toBe('1')
      } else {
        await expect.poll(async () => (await runs(page, service.id))[0]?.phase).toBe('active')
        await page.waitForTimeout(500)
        await command(page, { type: 'script.cancel', id: (await runs(page, service.id))[0].id })
        expect((await runs(page, service.id))[0].status).toBe('cancelled')
      }
    }
  } finally { await close(desktop) }
})

test('HTTP 端口冲突、长连接有界清理及同脚本重新启动', async () => {
  const desktop = await launchDesktop()
  const sockets: ReturnType<typeof get>[] = []
  try {
    const port = await freePort()
    const source = serverSource.replace('res.end(\'沙箱响应\')', 'res.writeHead(200); res.write(\'保持连接\')').replace('server.listen(0,', `server.listen(${port},`)
    const script = await save(desktop.page, draft(source, 'service'))
    for (let attempt = 0; attempt < 2; attempt++) {
      await command(desktop.page, { type: 'script.run', scriptId: script.id, values: {} })
      await expect.poll(async () => (await runs(desktop.page, script.id))[0]?.phase).toBe('active')
      await new Promise<void>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${port}`, (response) => { response.resume(); resolve() })
        sockets.push(request); request.on('error', reject)
      })
      const conflict = await save(desktop.page, draft(source, 'service'))
      await command(desktop.page, { type: 'script.run', scriptId: conflict.id, values: {} })
      expect((await terminal(desktop.page, conflict.id)).error).toContain('EADDRINUSE')
      const started = Date.now()
      await command(desktop.page, { type: 'script.cancel', id: (await runs(desktop.page, script.id))[0].id })
      expect(Date.now() - started).toBeLessThan(8000)
      expect((await runs(desktop.page, script.id))[0].status).toBe('cancelled')
      await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
    }
  } finally { for (const request of sockets) request.destroy(); await close(desktop) }
})

test('初始化死循环可超时，stdout 洪水和高频输出保持有界', async () => {
  const desktop = await launchDesktop()
  try {
    const hung = await save(desktop.page, { ...draft('while (true) {}', 'service'), timeout: 1 })
    await command(desktop.page, { type: 'script.run', scriptId: hung.id, values: {} })
    expect((await terminal(desktop.page, hung.id)).status).toBe('timeout')
    const script = await save(desktop.page, draft(`
const { once } = require('node:events');
for (let i = 0; i < 10000; i++) { console.log('洪水', i); octo.output(i); }
const chunk = Buffer.alloc(65536, 'x');
for (let i = 0; i < 128; i++) if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
await octo.sleep(1200);
console.log('洪水结束后的日志');
`, 'service'))
    await command(desktop.page, { type: 'script.run', scriptId: script.id, values: {} })
    await expect.poll(async () => (await runs(desktop.page, script.id))[0]?.phase).toBe('active')
    const run = (await runs(desktop.page, script.id))[0]
    expect(run.result).toBe('9999')
    expect(run.logs.length).toBeLessThanOrEqual(300)
    expect(run.logs.some((item) => item.text === '洪水结束后的日志')).toBe(true)
    expect(run.droppedLogs).toBeGreaterThan(9000)
    await command(desktop.page, { type: 'script.cancel', id: run.id })
  } finally { await close(desktop) }
})

test('真实 MCP 沙箱无网站运行、默认参数、就绪轮询与权限限制', async () => {
  const desktop = await launchDesktop()
  try {
    const { page } = desktop
    const full = await page.evaluate(() => window.octo.secret({ type: 'create', draft: { alias: '沙箱 Agent', level: 'full' } }))
    const read = await page.evaluate(() => window.octo.secret({ type: 'create', draft: { alias: '只读 Agent', level: 'read' } }))
    if (!full.ok || !read.ok) throw new Error('测试身份创建失败')
    const port = await freePort()
    await command(page, { type: 'mcp.save', settings: { enabled: true, port } })
    const call = async (name: string, args: unknown = {}, secret = full.data.secret) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      const reply = await response.json() as { result: { content: { text: string }[]; isError?: boolean } }
      if (reply.result.isError) throw new Error(reply.result.content[0].text)
      return reply.result.content[0].text
    }
    expect(await call('script_guide', {}, read.data.secret)).toContain('sandbox_service')
    const value = { ...draft('await octo.sleep(200); return { value: octo.vars.number };', 'service'), variables: [{ key: 'number', label: '数字', kind: 'number', required: true, default: 3 }] }
    const { script_id } = JSON.parse(await call('save_script', { draft: value }))
    expect(await call('list_scripts', { kind: 'sandbox', url: 'https://example.com' }, read.data.secret)).toContain(script_id)
    const { run_id } = JSON.parse(await call('run_script', { script_id, values: { number: 7 } }))
    await expect.poll(async () => JSON.parse(await call('read_script_runs', { script_id, run_id }, read.data.secret))[0]?.phase).toBe('active')
    expect(JSON.parse(await call('read_script_runs', { script_id, run_id }))[0].result).toBe('{"value":7}')
    for (const name of ['save_script', 'run_script', 'cancel_script_run', 'delete_script']) await expect(call(name, { script_id, run_id }, read.data.secret)).rejects.toThrow('身份')
    await call('cancel_script_run', { run_id })
    const next = JSON.parse(await call('run_script', { script_id }))
    await expect.poll(async () => JSON.parse(await call('read_script_runs', { script_id, run_id: next.run_id }))[0]?.phase).toBe('active')
    expect(JSON.parse(await call('read_script_runs', { script_id, run_id: next.run_id }))[0].result).toBe('{"value":3}')
    await call('cancel_script_run', { run_id: next.run_id })
    await call('delete_script', { script_id })
    expect((await state(page)).scripts).toHaveLength(0)
  } finally { await close(desktop) }
})

test('应用正常退出及强制结束后服务释放，记录恢复但不自动续跑', async () => {
  for (const force of [false, true]) {
    let desktop = await launchDesktop()
    try {
      const script = await save(desktop.page, draft(serverSource, 'service'))
      await command(desktop.page, { type: 'script.run', scriptId: script.id, values: {} })
      await expect.poll(async () => (await runs(desktop.page, script.id))[0]?.phase).toBe('active')
      const { port } = JSON.parse((await runs(desktop.page, script.id))[0].result!)
      await desktop.page.waitForTimeout(700)
      const dataDir = desktop.dataDir
      if (force) {
        const exited = new Promise((resolve) => desktop.application.process().once('exit', resolve))
        desktop.application.process().kill('SIGKILL')
        await exited
      } else {
        await desktop.application.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox })
        await desktop.application.close()
      }
      await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }); return true } catch { return false } }).toBe(false)
      desktop = await launchDesktop(dataDir)
      const run = (await runs(desktop.page, script.id))[0]
      expect(run.status).toBe(force ? 'interrupted' : 'cancelled')
      expect((await state(desktop.page)).scriptRuns).toHaveLength(0)
    } finally { await close(desktop).catch(() => undefined) }
  }
})
