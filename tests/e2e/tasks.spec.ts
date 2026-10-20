import type { Page } from '@playwright/test'
import type { ScriptDraft } from '../../src/shared/scripts'
import type { TaskDraft } from '../../src/shared/tasks'
import { expect, test } from '@playwright/test'
import { addSite, command, launchDesktop, state, stopAll, testSite } from './helpers'

async function taskRuns(page: Page, id: string) {
  return page.evaluate(async (id) => { const reply = await window.octo.taskRuns(id); if (!reply.ok) throw new Error(reply.error); return reply.data }, id)
}

const scriptDraft: ScriptDraft = {
  kind: 'action', name: '任务步骤脚本', description: '把变量写入页面并回读', match: ['127.0.0.1'],
  variables: [{ key: 'query', label: '输入内容', kind: 'text', required: false, default: '默认输入' }], dependencies: [], timeout: 60,
  source: 'await page.waitForSelector(\'#text\'); await page.type(\'#text\', octo.vars.query); const value = await page.$eval(\'#text\', (el) => el.value); return { value, siteName: octo.site.name };'
}

test('多步任务串行执行、变量继承与定时开关的保存展示', async () => {
  const website = await testSite()
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined
  try {
    desktop = await launchDesktop()
    const { page } = desktop
    const a = await addSite(page, '任务账号 A', `${website.origin}/?client=a`)
    const b = await addSite(page, '任务账号 B', `${website.origin}/?client=b`)
    await command(page, { type: 'browser.start', siteId: a.id })
    await command(page, { type: 'browser.start', siteId: b.id })
    await expect.poll(() => website.reports.size).toBe(2)
    await command(page, { type: 'script.save', draft: scriptDraft })
    const script = (await state(page)).scripts.find((item) => item.draft.name === '任务步骤脚本')!

    // 两步分别绑定不同网站：步骤一引用任务变量，步骤二使用步骤自定义值。
    const draft: TaskDraft = {
      name: '双站点任务', description: '演示任务变量继承',
      variables: [{ key: 'shared', label: '共享输入', kind: 'text', required: false, default: '任务变量值' }],
      values: { shared: '任务变量值' },
      steps: [
        { scriptId: script.id, siteId: a.id, values: {}, links: { query: 'shared' }, optional: false },
        { scriptId: script.id, siteId: b.id, values: { query: '步骤自定义 B' }, links: {}, optional: false }
      ],
      onError: 'stop', schedule: { enabled: false, cron: '' }
    }
    await command(page, { type: 'task.save', draft })
    const task = (await state(page)).config.tasks.find((item) => item.draft.name === '双站点任务')!

    await page.getByRole('button', { name: /任务编排/ }).click()
    const row = page.getByRole('row').filter({ hasText: '双站点任务' })
    await expect(row).toBeVisible()
    await expect(row).toContainText('2 步')
    await row.getByRole('button', { name: '运行', exact: true }).click()

    await expect.poll(async () => (await taskRuns(page, task.id))[0]?.status).toBe('success')
    const run = (await taskRuns(page, task.id))[0]
    expect(run.steps.map((step) => step.status)).toEqual(['success', 'success'])
    expect(run.steps.every((step) => step.scriptRunId)).toBe(true)
    await expect.poll(() => website.reports.get('a')?.text).toBe('任务变量值')
    await expect.poll(() => website.reports.get('b')?.text).toBe('步骤自定义 B')

    // 界面日志：打开运行记录，逐步状态与底层脚本运行可见。
    await row.getByRole('button', { name: '日志', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('双站点任务')
    await expect(dialog.getByText('成功').first()).toBeVisible()
    await dialog.getByRole('button', { name: '脚本日志' }).first().click()
    await expect(page.getByRole('log')).toContainText('开始执行')
    await page.screenshot({ path: 'test-results/task-runs.png' })
    await page.getByRole('dialog').last().press('Escape')
    await page.getByRole('dialog').press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    // 定时开关：填入 cron 后启用，界面展示已启用与下次运行，配置落盘。
    await command(page, { type: 'task.save', id: task.id, draft: { ...draft, schedule: { enabled: false, cron: '0 9 * * *' } } })
    await row.getByRole('switch').click()
    await expect.poll(async () => (await state(page)).config.tasks[0]?.draft.schedule.enabled).toBe(true)
    await expect(row).toContainText('已启用')
    await expect(row).toContainText('0 9 * * *')
  } finally {
    if (desktop) await stopAll(desktop.application, desktop.page).catch(() => undefined)
    await website.close()
  }
})
