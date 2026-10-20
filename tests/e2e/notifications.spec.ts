import type { Page } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import type { NotificationQuery } from '../../src/shared/notifications'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { channelDraftSchema } from '../../src/shared/notifications'
import { scriptDraftSchema } from '../../src/shared/scripts'
import { taskDraftSchema } from '../../src/shared/tasks'
import { addSite, command, launchDesktop, state, stopAll } from './helpers'

async function receiver() {
  const received: { body: string; auth?: string; cookie?: string }[] = [], pending: ServerResponse[] = []
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({ body: Buffer.concat(chunks).toString(), auth: req.headers.authorization, cookie: req.headers.cookie })
      if (req.url === '/hold') { pending.push(res); return }
      res.writeHead(req.url === '/fail' ? 500 : 204); res.end(); return
    }
    if (req.url === '/api') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return }
    res.setHeader('content-type', 'text/html')
    res.end('<html><head><title>通知测试页</title></head><body><div id="result"></div><script>document.cookie="private_cookie=secret"; fetch("/api").then(r=>r.json()).then(v=>document.querySelector("#result").textContent=JSON.stringify(v))</script></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received, release: () => pending.splice(0).forEach((res) => { res.writeHead(204); res.end() }), close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
async function logs(page: Page, query: NotificationQuery = {}) {
  return page.evaluate(async (query) => { const reply = await window.octo.notificationLogs(query); if (!reply.ok) throw new Error(reply.error); return reply.data }, query)
}
async function runs(page: Page, id: string) {
  return page.evaluate(async (id) => { const reply = await window.octo.scriptRuns(id); if (!reply.ok) throw new Error(reply.error); return reply.data }, id)
}
async function saveChannel(page: Page, key: string, url: string) {
  await command(page, { type: 'notification.save', draft: channelDraftSchema.parse({ key, name: key, kind: 'webhook' }), settings: { url, allowHttp: true } })
}

test('通知界面创建编辑、真实测试发送、凭据保护、停用删除及重启恢复', async () => {
  const target = await receiver()
  let desktop = await launchDesktop()
  try {
    const { page } = desktop
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: /通知管理/ }).click()
    await page.getByRole('button', { name: /新建通道/ }).click()
    await page.getByLabel('显示名称', { exact: true }).fill('本地测试通知')
    await page.getByLabel('调用标识', { exact: true }).fill('local-notify')
    await page.getByLabel('渠道类型', { exact: true }).click()
    await page.getByTitle('通用 Webhook', { exact: true }).click()
    await page.getByLabel('Webhook 地址', { exact: true }).fill(`${target.origin}/notify?private-token`)
    await page.getByRole('checkbox', { name: /允许 HTTP/ }).check()
    await page.getByRole('button', { name: '添加 Header' }).click()
    await page.getByRole('textbox', { name: 'Header 名称', exact: true }).fill('Authorization')
    await page.getByLabel('Header 值', { exact: true }).fill('Bearer private-header')
    await page.getByRole('button', { name: '保存通道' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    const row = page.getByRole('row').filter({ hasText: '本地测试通知' })
    await expect(row).toContainText('local-notify')
    expect(target.received).toHaveLength(0)
    await row.getByRole('button', { name: /复制|Copy/ }).click()
    await expect.poll(() => desktop.application.evaluate(({ clipboard }) => clipboard.readText())).toContain('octo.notify("local-notify",')
    const channel = (await state(page)).notifications[0]
    await row.getByRole('button', { name: /^编\s*辑$/ }).click()
    await expect(page.getByLabel('调用标识', { exact: true })).toBeDisabled()
    await expect(page.getByLabel('Webhook 地址', { exact: true })).toHaveValue('')
    await page.getByLabel('显示名称', { exact: true }).fill('本地测试通知-改名')
    await page.getByRole('button', { name: '保存通道' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await row.getByRole('button', { name: /^测\s*试$/ }).click()
    await page.getByRole('button', { name: '发送测试', exact: true }).click()
    await expect.poll(async () => (await logs(page)).items[0]?.status).toBe('accepted')
    expect(target.received[0].auth).toBe('Bearer private-header')
    expect(target.received[0].cookie).toBeUndefined()
    expect(target.received[0].body).toContain('Octo Fetch 测试通知')
    await expect(page.getByRole('tab', { name: '发送日志' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: /^详\s*情$/ }).click()
    await expect(page.getByRole('dialog')).toContainText('服务端已受理')
    await page.getByRole('dialog').getByRole('button', { name: /^关\s*闭$/ }).last().click()
    await page.screenshot({ path: 'test-results/notification-logs.png' })
    await page.getByRole('combobox', { name: '筛选通知状态' }).click()
    await page.getByTitle('失败', { exact: true }).click()
    await expect(page.getByText('暂无通知记录', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '筛选通知状态' }).click()
    await page.getByTitle('服务端已受理', { exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: '本地测试通知-改名' })).toBeVisible()
    await page.getByRole('combobox', { name: '筛选通知来源' }).click()
    await page.getByTitle('测试发送', { exact: true }).click()
    await page.getByRole('combobox', { name: '筛选通知通道' }).click()
    await page.getByTitle('本地测试通知-改名 · local-notify', { exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: '本地测试通知-改名' })).toBeVisible()
    await page.getByRole('tab', { name: '通知通道' }).click()
    await row.getByRole('switch').click()
    await expect(row.getByRole('button', { name: /^测\s*试$/ })).toBeDisabled()
    await page.screenshot({ path: 'test-results/notification-channels.png' })
    const exposed = JSON.stringify(await state(page)) + await readFile(path.join(desktop.dataDir, 'config.json'), 'utf8') + await readFile(path.join(desktop.dataDir, 'config.json.bak'), 'utf8')
    expect(exposed).not.toContain('private-token'); expect(exposed).not.toContain('private-header')
    expect(errors).toEqual([])
    const directory = desktop.dataDir
    await stopAll(desktop.application, page)
    desktop = await launchDesktop(directory)
    expect((await state(desktop.page)).notifications[0]).toMatchObject({ id: channel.id, enabled: false, name: '本地测试通知-改名' })
    expect((await logs(desktop.page)).items[0].status).toBe('accepted')
    await desktop.page.getByRole('button', { name: /通知管理/ }).click()
    await desktop.page.getByRole('row').filter({ hasText: '本地测试通知-改名' }).getByRole('button', { name: /^删\s*除$/ }).click()
    await desktop.page.getByRole('dialog').getByRole('button', { name: /^删\s*除$/ }).click()
    await expect.poll(async () => (await state(desktop.page)).notifications.length).toBe(0)
    expect((await logs(desktop.page)).total).toBe(1)
    await desktop.page.getByRole('tab', { name: '发送日志' }).click()
    await desktop.page.getByRole('button', { name: '清空终态日志' }).click()
    await desktop.page.getByRole('dialog').getByRole('button', { name: /^清\s*空$/ }).click()
    await expect.poll(async () => (await logs(desktop.page)).total).toBe(0)
  } finally { await stopAll(desktop.application, desktop.page).catch(() => undefined); await target.close() }
})

test('机器人和邮件表单保存与敏感字段保留，切换渠道不串配置', async () => {
  const desktop = await launchDesktop(), { page } = desktop
  try {
    await page.getByRole('button', { name: /通知管理/ }).click()
    const configs = [
      { key: 'ding', label: '钉钉机器人', url: 'https://oapi.dingtalk.com/robot/send?access_token=test-only', signed: true },
      { key: 'wecom', label: '企业微信机器人', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only', signed: false },
      { key: 'feishu', label: '飞书机器人', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only', signed: true },
      { key: 'mail', label: 'SMTP 邮件', url: '', signed: false }
    ]
    for (const item of configs) {
      await page.getByRole('button', { name: /新建通道/ }).click()
      await page.getByLabel('显示名称', { exact: true }).fill(item.key)
      await page.getByLabel('调用标识', { exact: true }).fill(item.key)
      if (item.key === 'ding') {
        await page.getByLabel('渠道类型', { exact: true }).click(); await page.getByTitle('通用 Webhook', { exact: true }).click()
        await page.getByRole('button', { name: '添加 Header' }).click()
        await page.getByRole('textbox', { name: 'Header 名称', exact: true }).fill('Authorization')
        await page.getByLabel('Header 值', { exact: true }).fill('不要带入机器人')
      }
      await page.getByLabel('渠道类型', { exact: true }).click(); await page.getByTitle(item.label, { exact: true }).click()
      if (item.url) {
        await page.getByLabel('Webhook 地址', { exact: true }).fill(item.url)
        if (item.signed) await page.getByLabel('签名密钥（可选）', { exact: true }).fill('test-sign-only')
      } else {
        await page.getByLabel('SMTP 主机', { exact: true }).fill('smtp.example.com')
        await page.getByLabel('SMTP 端口', { exact: true }).fill('587')
        await page.getByLabel('连接安全', { exact: true }).click(); await page.getByTitle('强制 STARTTLS（通常为 587）', { exact: true }).click()
        await page.getByLabel('认证账号', { exact: true }).fill('test-user')
        await page.getByLabel('密码 / 授权码', { exact: true }).fill('test-password-only')
        await page.getByLabel('发件邮箱', { exact: true }).fill('from@example.com')
        for (const email of ['one@example.com', 'two@example.com']) { await page.getByLabel('收件邮箱', { exact: true }).fill(email); await page.getByLabel('收件邮箱', { exact: true }).press('Enter') }
      }
      await page.getByRole('button', { name: '保存通道' }).click(); await expect(page.getByRole('dialog')).toBeHidden()
      const channel = (await state(page)).notifications.find((channel) => channel.key === item.key)!
      const row = page.getByRole('row').filter({ hasText: item.label })
      await row.getByRole('button', { name: /^编\s*辑$/ }).click()
      if (item.url) await expect(page.getByLabel('Webhook 地址', { exact: true })).toHaveValue('')
      else await expect(page.getByLabel('密码 / 授权码', { exact: true })).toHaveValue('')
      if (item.signed) await page.getByRole('checkbox', { name: '清除已保存的签名密钥' }).check()
      await page.getByRole('button', { name: '保存通道' }).click(); await expect(page.getByRole('dialog')).toBeHidden()
      const detail = await page.evaluate((id) => window.octo.notification(id), channel.id)
      expect(detail.ok && detail.data.configured).toMatchObject({ url: Boolean(item.url), password: !item.url, secret: false })
    }
    expect((await state(page)).notifications).toHaveLength(4)
    expect((await logs(page)).total).toBe(0)
  } finally { await stopAll(desktop.application, page).catch(() => undefined) }
})

test('应用退出将未确认投递标为未知，重启不重复发送', async () => {
  const target = await receiver()
  let desktop = await launchDesktop()
  try {
    await saveChannel(desktop.page, 'delayed', `${target.origin}/hold`)
    const channel = (await state(desktop.page)).notifications[0]
    await command(desktop.page, { type: 'notification.test', id: channel.id })
    await command(desktop.page, { type: 'notification.test', id: channel.id })
    await expect.poll(() => target.received.length).toBe(1)
    const directory = desktop.dataDir
    await stopAll(desktop.application, desktop.page)
    const stored = JSON.parse(await readFile(path.join(directory, 'notification-logs.json'), 'utf8')) as { status: string }[]
    expect(stored.map((item) => item.status).sort()).toEqual(['interrupted', 'unknown'])
    target.release()
    desktop = await launchDesktop(directory)
    expect((await logs(desktop.page)).items.map((item) => item.status).sort()).toEqual(['interrupted', 'unknown'])
    expect(target.received).toHaveLength(1)
  } finally { target.release(); await stopAll(desktop.application, desktop.page).catch(() => undefined); await target.close() }
})

test('真实行动结束/取消后继续投递，注入失败不停止钩子，编排继续下一步', async () => {
  const target = await receiver(), desktop = await launchDesktop()
  const { page } = desktop
  try {
    await saveChannel(page, 'delayed', `${target.origin}/hold`)
    await saveChannel(page, 'failure', `${target.origin}/fail`)
    const site = await addSite(page, '通知账号', target.origin)
    const injection = scriptDraftSchema.parse({ kind: 'injection', name: '通知注入', match: ['127.0.0.1'], source: `octo.interceptResponse({urlPattern:'*/api'}, ({response}) => { octo.notify('failure', '注入通知'); return {body:JSON.stringify({...JSON.parse(response.body), injected:true})}; });` })
    await command(page, { type: 'script.save', draft: injection })
    const injectionId = (await state(page)).scripts.find((item) => item.draft.name === injection.name)!.id
    await command(page, { type: 'site.save', id: site.id, draft: { name: site.name, url: site.url, injections: [{ scriptId: injectionId, enabled: true, values: {} }] } })
    await command(page, { type: 'browser.start', siteId: site.id })
    await expect.poll(async () => (await logs(page, { kind: 'injection' })).items[0]?.status).toBe('failed')
    expect((await runs(page, injectionId))[0].phase).toBe('active')
    const action = scriptDraftSchema.parse({ name: '通知行动', match: ['127.0.0.1'], source: `octo.notify('delayed', {title:'行动通知',content:'private-business-body'}); await page.waitForFunction(() => document.querySelector('#result').textContent); return page.$eval('#result',el=>JSON.parse(el.textContent));` })
    await command(page, { type: 'script.save', draft: action })
    const actionId = (await state(page)).scripts.find((item) => item.draft.name === action.name)!.id
    await command(page, { type: 'script.run', scriptId: actionId, siteId: site.id, values: {} })
    await expect.poll(async () => (await runs(page, actionId))[0]?.status).toBe('success')
    const run = (await runs(page, actionId))[0]
    expect(JSON.parse(run.result!)).toEqual({ ok: true, injected: true })
    expect((await logs(page, { runId: run.id })).items[0].status).toBe('sending')
    target.release()
    await expect.poll(async () => (await logs(page, { runId: run.id })).items[0]?.status).toBe('accepted')
    expect((await runs(page, actionId))[0].status).toBe('success')
    expect(JSON.stringify(await logs(page))).not.toContain('private-business-body')
    expect(target.received.every((item) => !item.cookie)).toBe(true)

    await page.getByRole('button', { name: /脚本能力/ }).click()
    await page.getByRole('row').filter({ hasText: '通知行动' }).getByRole('button', { name: /^日\s*志$/ }).click()
    await page.getByRole('button', { name: '查看关联通知' }).click()
    await expect(page.getByRole('dialog').last()).toContainText('服务端已受理')
    await page.getByRole('dialog').last().press('Escape'); await page.getByRole('dialog').press('Escape')

    await command(page, { type: 'script.save', id: actionId, draft: { ...action, source: `octo.notify('delayed','取消后也继续'); await octo.sleep(30000);` } })
    await command(page, { type: 'script.run', scriptId: actionId, siteId: site.id, values: {} })
    await expect.poll(async () => (await logs(page, { status: 'sending' })).total).toBe(1)
    const cancelled = (await runs(page, actionId))[0]
    await command(page, { type: 'script.cancel', id: cancelled.id }); target.release()
    await expect.poll(async () => (await logs(page, { runId: cancelled.id })).items[0]?.status).toBe('accepted')
    expect((await runs(page, actionId))[0].status).toBe('cancelled')

    await command(page, { type: 'script.save', id: actionId, draft: { ...action, source: `octo.notify('failure','失败不影响步骤'); octo.notify('missing','不存在通道'); octo.notify(null, 123); return 42;` } })
    await command(page, { type: 'task.save', draft: taskDraftSchema.parse({ name: '通知隔离任务', steps: [{ scriptId: actionId, siteId: site.id }, { scriptId: actionId, siteId: site.id }] }) })
    const taskId = (await state(page)).config.tasks[0].id
    await command(page, { type: 'task.run', id: taskId })
    await expect.poll(async () => page.evaluate(async (id) => { const r = await window.octo.taskRuns(id); return r.ok ? r.data[0]?.status : r.error }, taskId)).toBe('success')
    await command(page, { type: 'browser.stop', siteId: site.id })
    expect((await runs(page, injectionId))[0].status).toBe('success')
  } finally { target.release(); await stopAll(desktop.application, page).catch(() => undefined); await target.close() }
})
