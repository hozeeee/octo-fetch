import type { Snapshot } from '../shared/model'
import type { Encryptor } from './storage/store'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, Menu, safeStorage, session } from 'electron'
import { BrowserManager, resolveBrowser } from './browser/manager'
import { CaptureAccess } from './capture/access'
import { CaptureService } from './capture/service'
import { CaptureView } from './capture/view'
import { registerIPC } from './ipc/register'
import { McpService } from './mcp/server'
import { TokenRegistry } from './mcp/tokens'
import { NotificationService } from './notifications/service'
import { NotificationLogStore, NotificationVault } from './notifications/store'
import { InjectionService } from './scripts/injections'
import { ScriptRunner } from './scripts/runner'
import { ScriptLogStore, ScriptStore } from './scripts/store'
import { DataStore } from './storage/data-store'
import { ProxyVault } from './storage/proxy-vault'
import { ConfigStore, CookieVault, SecretVault } from './storage/store'
import { TaskService } from './tasks/service'
import { TaskLogStore } from './tasks/store'

if (!app.isPackaged && process.env.OCTO_DATA_DIR) app.setPath('userData', path.resolve(process.env.OCTO_DATA_DIR))
let window: BrowserWindow | undefined
let manager: BrowserManager | undefined
let mcp: McpService | undefined
let scripts: ScriptRunner | undefined
let notifications: NotificationService | undefined
let dataStore: DataStore | undefined
let capture: CaptureService | undefined
let quitting = false
let asking = false

async function requestQuit(): Promise<void> {
  if (asking || quitting) return
  asking = true
  try {
    if ((manager?.runningCount() || scripts?.sandbox.active().length) && window) {
      const answer = await dialog.showMessageBox(window, {
        type: 'question', message: scripts?.sandbox.active().length ? '停止全部网站和沙箱并退出？' : '停止全部网站并退出？', detail: '将保存 Cookie 快照、关闭受控浏览器并停止沙箱服务。独立登录目录和沙箱文件会保留，下次启动不自动恢复沙箱。',
        buttons: ['取消', '停止并退出'], defaultId: 0, cancelId: 0
      })
      if (answer.response !== 1) return
    }
    await mcp?.stop().catch(() => undefined)
    await manager?.tasks?.shutdown()
    await scripts?.shutdown()
    await manager?.shutdown()
    await capture?.shutdown()
    await notifications?.shutdown()
    await dataStore?.flush().catch(() => undefined)
    const warnings = manager?.states().filter((state) => state.warning?.includes('保存失败'))
    if (warnings?.length && window) await dialog.showMessageBox(window, { type: 'warning', message: '部分 Cookie 快照未能保存', detail: '浏览器登录目录仍然保留。请在下次启动后检查钥匙串授权。' })
    quitting = true
    app.quit()
  } catch (error) {
    dialog.showErrorBox('暂时无法退出', `停止运行或保存数据失败，请检查后重试。\n${error instanceof Error ? error.message : String(error)}`)
  } finally { asking = false }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() })
  app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); void requestQuit() } })
  app.on('activate', () => { window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    app.setName('Octo Fetch')
    const store = new ConfigStore(app.getPath('userData'))
    await store.initialize()
    const encryptor: Encryptor = {
      async encrypt(text) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('钥匙串加密不可用，无法安全保存敏感配置')
        return safeStorage.encryptStringAsync(text)
      },
      async decrypt(data) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('钥匙串解密不可用')
        return (await safeStorage.decryptStringAsync(data)).result
      }
    }
    const vault = new CookieVault(store.directory, encryptor)
    await vault.initialize()
    const secrets = new SecretVault(store.directory, encryptor)
    window = new BrowserWindow({
      width: 1440, height: 960, minWidth: 1000, minHeight: 720, show: false,
      title: 'Octo Fetch', titleBarStyle: 'hiddenInset', backgroundColor: '#f6f7f9',
      webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true }
    })
    const mainWindow = window
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
    const browserRoot = app.isPackaged ? path.join(process.resourcesPath, 'browser') : path.join(app.getAppPath(), '.browsers', process.arch)
    const browserInfo = await resolveBrowser(browserRoot).catch(() => ({ version: '未准备，请运行 browser:prepare' }))
    let updateTimer: NodeJS.Timeout | undefined
    const snapshot = (): Snapshot => ({
      notifications: notifications?.list() || [], config: store.get(), runtimes: manager!.states(), scripts: scriptStore.list(), scriptRuns: scripts!.active(), taskRuns: manager!.tasks!.active(),
      info: { version: app.getVersion(), nodeVersion: process.versions.node, browserVersion: browserInfo.version, dataDir: store.directory, arch: process.arch }, warnings: [...store.warnings, ...scriptStore.warnings, ...(scripts?.persistenceError ? [scripts.persistenceError] : []), ...(scripts?.sandbox.persistenceError ? [scripts.sandbox.persistenceError] : []), ...(manager?.injections?.persistenceError ? [manager.injections.persistenceError] : []), ...(manager?.tasks?.persistenceError ? [manager.tasks.persistenceError] : []), ...(notifications?.warning ? [notifications.warning] : []), ...(notifications?.logs.warning ? [notifications.logs.warning] : []), ...(dataStore?.warning ? [dataStore.warning] : [])],
      capture: capture!.state(), mcp: mcp!.state(), data: dataStore?.summary() ?? { total: 0, collections: [], kinds: {} }
    })
    const changed = () => {
      if (updateTimer) return
      updateTimer = setTimeout(() => {
        updateTimer = undefined
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('octo:state', snapshot())
      }, 40)
    }
    manager = new BrowserManager(store, vault, browserRoot, changed, (frame) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('octo:frame', frame)
    }, new ProxyVault(store.directory, encryptor))
    const scriptStore = new ScriptStore(store.directory, changed)
    await scriptStore.initialize()
    const scriptLogs = new ScriptLogStore(store.directory)
    dataStore = new DataStore(store.directory, changed)
    await dataStore.initialize()
    const notificationLogs = new NotificationLogStore(store.directory, changed)
    notifications = new NotificationService(store, new NotificationVault(store.directory, encryptor), notificationLogs, changed)
    await notificationLogs.initialize()
    capture = new CaptureService(store, new ProxyVault(store.directory, encryptor, 'capture'), changed)
    const captureAccess = new CaptureAccess(store, capture)
    scripts = new ScriptRunner(scriptStore, scriptLogs, manager, changed, undefined, notifications, undefined, dataStore, captureAccess)
    manager.injections = new InjectionService(scriptStore, scriptLogs, store, changed, notifications, dataStore, captureAccess, scripts.packages)
    const taskLogs = new TaskLogStore(store.directory)
    manager.tasks = new TaskService(store, scripts, taskLogs, changed)
    manager.captureService = capture
    capture.onUnavailable = (ids) => manager?.captureUnavailable(ids)
    const captureView = new CaptureView(mainWindow, capture)
    const tokens = new TokenRegistry(store, secrets, changed)
    mcp = new McpService(manager, tokens, app.getVersion(), changed, scripts)
    const url = process.env.ELECTRON_RENDERER_URL && !app.isPackaged
      ? new URL(process.env.ELECTRON_RENDERER_URL).href
      : pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
    registerIPC(mainWindow, manager, tokens, mcp, snapshot, changed, url, scripts, manager.tasks, notifications, dataStore, capture, captureView)
    mainWindow.on('ready-to-show', () => mainWindow.show())
    mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); void requestQuit() } })
    const pauseFrames = () => { void manager?.setWindowVisible(false).catch(() => undefined) }
    const resumeFrames = () => { void manager?.setWindowVisible(true).catch(() => undefined) }
    mainWindow.on('minimize', pauseFrames)
    mainWindow.on('hide', pauseFrames)
    mainWindow.on('restore', resumeFrames)
    mainWindow.on('show', resumeFrames)
    mainWindow.webContents.on('render-process-gone', () => { void manager?.setWindowVisible(false).catch(() => undefined) })
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Octo Fetch', submenu: [{ role: 'about', label: '关于 Octo Fetch' }, { type: 'separator' }, { role: 'hide', label: '隐藏' }, { role: 'quit', label: '退出' }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const, label: '开发者工具' }] : [])] }
    ]))
    await mainWindow.loadURL(url)
    await capture.initialize()
    manager.tasks.start()
    await mcp.apply()
  }).catch(async () => {
    dialog.showErrorBox('Octo Fetch 启动失败', '无法初始化应用。请检查数据目录权限、配置及备份文件；原有数据不会被清空。')
    await manager?.tasks?.shutdown().catch(() => undefined)
    await scripts?.shutdown().catch(() => undefined)
    await manager?.shutdown().catch(() => undefined)
    await capture?.shutdown().catch(() => undefined)
    await notifications?.shutdown().catch(() => undefined)
    await dataStore?.flush().catch(() => undefined)
    quitting = true; app.quit()
  })
}
