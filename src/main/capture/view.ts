import type { BrowserWindow } from 'electron'
import type { CaptureViewBounds } from '../../shared/capture'
import type { CaptureService } from './service'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { dialog, session, WebContentsView } from 'electron'
import { captureViewSchema } from '../../shared/capture'

export class CaptureView {
  private view?: WebContentsView
  private origin?: string
  private requested?: CaptureViewBounds
  private suspended = 0
  private creating?: Promise<void>
  constructor(private window: BrowserWindow, private service: CaptureService) {
    window.on('resize', () => this.layout())
    window.on('minimize', () => this.layout())
    window.on('restore', () => this.layout())
    window.on('hide', () => this.layout())
    window.on('show', () => this.layout())
    window.on('closed', () => this.destroy())
    window.webContents.on('render-process-gone', () => { this.requested = undefined; this.layout() })
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { this.requested = undefined; this.layout() } })
    service.onStopped = () => this.destroy()
  }
  async setBounds(raw: unknown) {
    this.requested = captureViewSchema.parse(raw)
    if (this.requested.visible && !this.view) {
      this.creating ||= this.create().finally(() => { this.creating = undefined })
      await this.creating
    }
    this.layout()
  }
  suspend() { this.suspended++; this.layout(); return () => { this.suspended = Math.max(0, this.suspended - 1); this.layout() } }
  private async create() {
    const ready = this.service.management()
    if (!ready) return
    const origin = `http://127.0.0.1:${ready.uiPort}`
    const isolated = session.fromPartition(`capture-${randomUUID()}`, { cache: false })
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setDevicePermissionHandler(() => false)
    const allowed = (url: string) => { try { return new URL(url).origin === origin } catch { return false } }
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) && !details.url.startsWith('data:') && !details.url.startsWith(`blob:${origin}/`) }))
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') delete headers[key]
      }
      if (allowed(details.url)) headers.Authorization = `Basic ${Buffer.from(`${ready.username}:${ready.password}`).toString('base64')}`
      callback({ requestHeaders: headers })
    })
    const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } })
    this.view = view; this.origin = origin
    view.setVisible(false); this.window.contentView.addChildView(view)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault() })
    view.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault() })
    view.webContents.on('will-frame-navigate', (event) => { if (!allowed(event.url)) event.preventDefault() })
    view.webContents.on('will-attach-webview', (event) => event.preventDefault())
    isolated.on('will-download', (event, item, contents) => {
      if (contents !== view.webContents || !item.getURLChain().every((url) => allowed(url) || url.startsWith(`blob:${origin}/`))) { event.preventDefault(); return }
      const resume = this.suspend()
      try {
        // 路径必须在 will-download 返回前设置，否则 Electron 会另开默认保存流程。
        const filePath = dialog.showSaveDialogSync(this.window, { title: '保存抓包文件（可能含 Cookie、凭据和正文）', defaultPath: path.basename(item.getFilename()) })
        if (!filePath || view.webContents.isDestroyed()) item.cancel()
        else item.setSavePath(filePath)
      } catch { item.cancel() } finally { resume() }
    })
    try {
      await view.webContents.loadURL(origin)
      if (this.service.management()?.uiPort !== ready.uiPort) { this.destroy(); return }
      this.layout()
    } catch (error) { if (this.view === view) this.destroy(); throw error }
  }
  private layout() {
    const view = this.view, bounds = this.requested
    if (!view || view.webContents.isDestroyed() || this.window.isDestroyed()) return
    const ready = this.service.management()
    const visible = Boolean(bounds?.visible && !this.suspended && this.window.isVisible() && !this.window.isMinimized() && ready && this.origin === `http://127.0.0.1:${ready.uiPort}`)
    if (bounds) {
      const [width, height] = this.window.getContentSize()
      const x = Math.min(bounds.x, width), y = Math.min(bounds.y, height)
      view.setBounds({ x, y, width: Math.max(0, Math.min(bounds.width, width - x)), height: Math.max(0, Math.min(bounds.height, height - y)) })
    }
    view.setVisible(visible)
  }
  destroy() {
    const view = this.view
    this.view = undefined; this.origin = undefined
    if (!view) return
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
    const isolated = view.webContents.session
    if (!view.webContents.isDestroyed()) view.webContents.close()
    isolated.webRequest.onBeforeRequest(null); isolated.webRequest.onBeforeSendHeaders(null)
    isolated.removeAllListeners('will-download')
    void isolated.clearStorageData().catch(() => undefined)
  }
}
