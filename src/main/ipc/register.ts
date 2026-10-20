import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { Frame, Reply, Snapshot } from '../../shared/model'
import type { BrowserManager } from '../browser/manager'
import type { CaptureService } from '../capture/service'
import type { CaptureView } from '../capture/view'
import type { McpService } from '../mcp/server'
import type { TokenRegistry } from '../mcp/tokens'
import type { NotificationService } from '../notifications/service'
import type { ScriptRunner } from '../scripts/runner'
import type { DataStore } from '../storage/data-store'
import type { TaskService } from '../tasks/service'
import { readFile, stat } from 'node:fs/promises'
import { dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { dataQuerySchema } from '../../shared/data-store'
import { commandSchema, idSchema, secretSchema } from '../../shared/model'
import { notificationQuerySchema } from '../../shared/notifications'
import { exportScript, importScript, MAX_SCRIPT_FILE_BYTES } from '../../shared/scripts'
import { atomicWrite } from '../storage/store'

export function registerIPC(window: BrowserWindow, manager: BrowserManager, tokens: TokenRegistry, mcp: McpService,
  snapshot: () => Snapshot, changed: () => void, trustedUrl: string, scripts: ScriptRunner, tasks: TaskService, notifications: NotificationService, dataStore: DataStore, capture: CaptureService, captureView: CaptureView): void {
  function authorize(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame
    if (event.sender !== window.webContents || !frame || frame !== window.webContents.mainFrame) throw new Error('调用来源不可信')
    const actual = new URL(frame.url)
    const expected = new URL(trustedUrl)
    if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname) throw new Error('调用来源不可信')
  }
  async function reply<T>(event: IpcMainInvokeEvent, operation: () => Promise<T> | T): Promise<Reply<T>> {
    try { authorize(event); return { ok: true, data: await operation() } } catch (error) {
      return { ok: false, error: error instanceof z.ZodError ? '参数格式无效，请检查输入' : error instanceof Error ? error.message.slice(0, 500) : '操作失败，请重试' }
    }
  }
  ipcMain.handle('octo:snapshot', (event) => reply(event, snapshot))
  ipcMain.handle('octo:script', (event, id: unknown) => reply(event, () => scripts.store.get(idSchema.parse(id))))
  ipcMain.handle('octo:install-deps', (event, id: unknown) => reply(event, () => scripts.installDependencies(idSchema.parse(id))))
  ipcMain.handle('octo:script-runs', (event, id: unknown) => reply(event, () => scripts.runs(idSchema.parse(id))))
  ipcMain.handle('octo:task-runs', (event, id: unknown) => reply(event, () => tasks.runsOf(idSchema.parse(id))))
  ipcMain.handle('octo:notification', (event, id: unknown) => reply(event, () => notifications.detail(idSchema.parse(id))))
  ipcMain.handle('octo:notification-logs', (event, query: unknown) => reply(event, () => notifications.logs.list(notificationQuerySchema.parse(query))))
  ipcMain.handle('octo:data-records', (event, query: unknown) => reply(event, () => dataStore.page(dataQuerySchema.parse(query))))
  ipcMain.handle('octo:capture-query', (event, query: unknown) => reply(event, () => capture.query(query)))
  ipcMain.handle('octo:capture-detail', (event, id: unknown) => reply(event, () => capture.detail(z.string().min(1).max(200).parse(id))))
  ipcMain.handle('octo:capture-view', (event, bounds: unknown) => reply(event, () => captureView.setBounds(bounds)))
  ipcMain.handle('octo:cookies', (event, id: unknown) => reply(event, () => manager.readCookies(idSchema.parse(id))))
  // 令牌明文走独立通道，只在生成和用户主动查看时返回。
  ipcMain.handle('octo:secret', (event, raw: unknown) => reply(event, () => {
    const request = secretSchema.parse(raw)
    return request.type === 'create' ? tokens.create(request.draft) : tokens.reveal(request.id)
  }))
  ipcMain.handle('octo:command', (event, raw: unknown) => reply(event, async () => {
    const command = commandSchema.parse(raw)
    const resumeCapture = captureView.suspend()
    try {
      switch (command.type) {
        case 'capture.save': await capture.save(command.settings, command.credentials); break
        case 'capture.start': await capture.start(); break
        case 'capture.stop': case 'capture.restart': {
          const restart = command.type === 'capture.restart'
          if (capture.state().sites.length) {
            const answer = await dialog.showMessageBox(window, { type: 'warning', message: '先停止关联网站，再停止抓包代理？', detail: 'Cookie 和登录目录会保留；不会自动重新导航。外部客户端需手动撤销代理设置。', buttons: ['取消', '停止关联网站并继续'], defaultId: 0, cancelId: 0 })
            if (answer.response === 1) await capture.stopWithSites(restart, async (ids) => { await Promise.all(ids.map((id) => manager.stop(id))) })
          } else if (restart) {
            await capture.restart()
          } else {
            await capture.stop()
          }
          break
        }
        case 'capture.site': await manager.setCaptureEnabled(command.siteId, command.enabled); break
        case 'capture.grant': {
          const script = scripts.store.get(command.scriptId)
          if (command.grant !== 'none') {
            const answer = await dialog.showMessageBox(window, { type: 'warning', message: `授权“${script.draft.name}”访问抓包？`, detail: `${script.draft.kind === 'sandbox' ? '沙箱可读取全部网站和外部客户端' : '仅可读取本运行网站'}的敏感 URL、Header 和正文。${command.grant === 'control' ? '同时允许启停抓包代理。' : ''}授权仅保存在本机，不随导出传播。`, buttons: ['取消', '确认授权'], defaultId: 0, cancelId: 0 })
            if (answer.response !== 1) break
          }
          await capture.grant(command.scriptId, command.grant); break
        }
        case 'capture.certificate.export': {
          const pem = await capture.certificate()
          const answer = await dialog.showSaveDialog(window, { title: '导出抓包 CA（仅公开证书）', defaultPath: 'octo-capture-ca.crt', filters: [{ name: 'CA 证书', extensions: ['crt'] }] })
          if (!answer.canceled && answer.filePath) await atomicWrite(answer.filePath, pem)
          break
        }
        case 'capture.certificate.reset': {
          const answer = await dialog.showMessageBox(window, { type: 'warning', message: '重置抓包 CA？', detail: '必须先停止代理及关联网站。所有外部客户端需要手动移除旧 CA 并重新安装新 CA；不会修改系统钥匙串。', buttons: ['取消', '重置 CA'], defaultId: 0, cancelId: 0 })
          if (answer.response === 1) await capture.resetCertificate()
          break
        }
        case 'notification.save': await notifications.save(command.id, command.draft, command.settings); break
        case 'notification.enable': await notifications.enable(command.id, command.enabled); break
        case 'notification.test': notifications.test(command.id); break
        case 'notification.logs.clear': notifications.logs.clear(); break
        case 'notification.delete': await notifications.remove(command.id); break
        case 'script.save': await scripts.save(command.id, command.draft, 'manual'); break
        case 'script.run': await scripts.start({ scriptId: command.scriptId, siteId: command.siteId, tabId: command.tabId, values: command.values }); break
        case 'script.cancel': await scripts.cancel(command.id); break
        case 'script.logs.clear': await scripts.clearLogs(command.id); break
        case 'script.delete': {
          const script = scripts.store.get(command.id)
          const answer = await dialog.showMessageBox(window, {
            type: 'warning', message: `删除脚本“${script.draft.name}”及运行记录？`, detail: '此操作不可撤销；网站和登录态不受影响。',
            buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0
          })
          if (answer.response === 1) await scripts.remove(command.id)
          break
        }
        case 'script.export': {
          const script = scripts.store.get(command.id)
          const answer = await dialog.showSaveDialog(window, { title: '导出可迁移脚本', defaultPath: `${script.draft.name.replace(/[^\p{L}\p{N}_-]/gu, '_')}.js`, filters: [{ name: 'JavaScript', extensions: ['js'] }] })
          if (!answer.canceled && answer.filePath) await atomicWrite(answer.filePath, exportScript(script.draft))
          break
        }
        case 'script.import': {
          const answer = await dialog.showOpenDialog(window, { title: '导入 Octo Fetch 脚本', filters: [{ name: 'JavaScript', extensions: ['js'] }], properties: ['openFile'] })
          if (!answer.canceled && answer.filePaths[0]) {
            if ((await stat(answer.filePaths[0])).size > MAX_SCRIPT_FILE_BYTES) throw new Error('脚本文件超过 8MB 限制')
            const draft = importScript(await readFile(answer.filePaths[0], 'utf8'))
            const confirm = await dialog.showMessageBox(window, { type: 'warning', message: `导入“${draft.name}”？`, detail: '脚本为可信本机代码。仅导入可信来源；导入后不会自动执行，请先检查源码。', buttons: ['取消', '导入'], defaultId: 0, cancelId: 0 })
            if (confirm.response === 1) await scripts.save(undefined, draft, 'import')
          }
          break
        }
        case 'task.save': await tasks.save(command.id, command.draft, 'manual'); break
        case 'task.run': await tasks.run(command.id, 'manual'); break
        case 'task.cancel': await tasks.cancel(command.id); break
        case 'task.enable': await tasks.enable(command.id, command.enabled); break
        case 'task.logs.clear': await tasks.clearLogs(command.id); break
        case 'task.delete': {
          const task = tasks.get(command.id)
          const answer = await dialog.showMessageBox(window, {
            type: 'warning', message: `删除任务“${task.draft.name}”及运行记录？`, detail: '此操作不可撤销；脚本和网站不受影响。',
            buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0
          })
          if (answer.response === 1) await tasks.remove(command.id)
          break
        }
        case 'site.save': await manager.saveSite(command.id, command.draft, command.proxyCredentials); break
        case 'site.delete': case 'site.clear': {
          const site = manager.store.site(command.siteId)
          const result = await dialog.showMessageBox(window, {
            type: 'warning', message: command.type === 'site.delete' ? `删除“${site.name}”及其登录数据？` : `清除“${site.name}”的全部登录数据？`,
            detail: '将停止此网站，并删除其独立浏览器目录与 Cookie 快照。此操作不可撤销。',
            buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
          })
          if (result.response === 1) await manager.clearSite(command.siteId, command.type === 'site.delete')
          break
        }
        case 'browser.start': await manager.start(command.siteId); break
        case 'browser.stop': await manager.stop(command.siteId); break
        case 'settings.save': await manager.saveSettings(command.settings); break
        case 'tab.new': await manager.newTab(command.siteId); break
        case 'tab.activate': await manager.tabAction(command, 'activate'); break
        case 'tab.close': await manager.tabAction(command, 'close'); break
        case 'tab.navigate': await manager.navigate(command, 'navigate', command.url); break
        case 'tab.back': await manager.navigate(command, 'back'); break
        case 'tab.forward': await manager.navigate(command, 'forward'); break
        case 'tab.reload': await manager.navigate(command, 'reload'); break
        case 'view':
          if (command.siteId) manager.store.site(command.siteId)
          await manager.setView(command.siteId, command.visible); break
        case 'input': await manager.input(command, command.input); break
        case 'cookie.capture': await manager.captureCookies(command.siteId); break
        case 'cookie.apply': await manager.applyCookies(command.siteId, command.changes); break
        case 'cookie.restore': await manager.restoreCookies(command.siteId); break
        case 'dialog.answer': await manager.answerDialog(command, command.dialogId, command.accept, command.text); break
        case 'data.open': {
          const error = await shell.openPath(manager.store.directory)
          if (error) throw new Error('无法打开数据目录')
          break
        }
        case 'data.delete': dataStore.remove(command.id); break
        case 'data.clear': {
          const answer = await dialog.showMessageBox(window, {
            type: 'warning', message: command.collection ? `清空集合“${command.collection}”的全部记录？` : '清空数据仓库的全部记录？',
            detail: '已写入的数据将被删除，此操作不可恢复。', buttons: ['取消', '确认清空'], defaultId: 0, cancelId: 0, noLink: true
          })
          if (answer.response === 1) dataStore.clear(command.collection)
          break
        }
        case 'data.export': {
          const answer = await dialog.showSaveDialog(window, { title: '导出数据仓库', defaultPath: 'octo-data.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
          if (!answer.canceled && answer.filePath) await atomicWrite(answer.filePath, dataStore.export(command.filter))
          break
        }
        case 'mcp.save': await mcp.save(command.settings); break
        case 'token.save': await tokens.save(command.id, command.draft); break
        case 'token.enable': await tokens.enable(command.id, command.enabled); break
        case 'token.rotate': await tokens.rotate(command.id); break
        case 'token.delete': {
          const token = tokens.list().find((item) => item.id === command.id)
          const result = await dialog.showMessageBox(window, {
            type: 'warning', message: `删除身份“${token?.alias || ''}”？`,
            detail: '已粘贴该令牌的接入端将立即无法调用，调用统计也会一并清除。此操作不可恢复。',
            buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
          })
          if (result.response === 1) await tokens.remove(command.id)
          break
        }
      }
      if (command.type !== 'input' && command.type !== 'view') changed()
    } finally { resumeCapture() }
  }))
  const ackSchema = z.object({ siteId: idSchema, generation: idSchema, tabId: idSchema, sequence: z.number().int().nonnegative() }).strict()
  ipcMain.on('octo:ack', (event, raw: unknown) => {
    try {
      authorize(event as IpcMainInvokeEvent)
      const result = ackSchema.safeParse(raw)
      if (result.success) manager.acknowledge(result.data as Omit<Frame, 'data'>)
    } catch { /* 忽略不可信帧确认。 */ }
  })
}
