import type { Protocol } from 'devtools-protocol'
import type { CDPSession, Page } from 'puppeteer-core'
import type { PageGeometry } from '../../shared/browser-options'
import type { Frame, Target } from '../../shared/model'
import { isPageCapturing, pageGeometry, pageScreenshot, withPageOperation } from './options'

export class LatestFrameMailbox {
  pending?: Frame
  inFlight?: Frame
  offer(frame: Frame): void { this.pending = frame }
  take(): Frame | undefined {
    if (this.inFlight || !this.pending) return
    this.inFlight = this.pending
    this.pending = undefined
    return this.inFlight
  }
  acknowledge(frame: Omit<Frame, 'data'>): void {
    const sent = this.inFlight
    if (sent && sent.sequence === frame.sequence && sent.tabId === frame.tabId && sent.generation === frame.generation && sent.siteId === frame.siteId) this.inFlight = undefined
  }
  clear(): void { this.pending = undefined; this.inFlight = undefined }
}

type Options = { fps: number; quality: number }
export class PageStream {
  private session?: CDPSession
  private disposed = false
  private fallback = false
  private capturing = false
  private lastCapture = 0
  private lastSent = 0
  private lastReceived = Date.now()
  private lastData = ''
  private measuring = false
  private pendingFrame?: Protocol.Page.ScreencastFrameEvent
  private timer?: NodeJS.Timeout
  readonly mailbox = new LatestFrameMailbox()
  constructor(
    private page: Page,
    private target: Target,
    private options: () => Options,
    private nextSequence: () => number,
    private send: (frame: Frame) => void,
    private mode: (mode: 'live' | 'fallback') => void
  ) {}

  async start(): Promise<void> {
    try {
      this.session = await this.page.createCDPSession()
      if (this.disposed) { await this.session.detach(); return }
      this.session.on('Page.screencastFrame', (event) => {
        void this.session?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
        this.lastReceived = Date.now()
        if (isPageCapturing(this.page)) return
        this.pendingFrame = event
        void this.measureFrame()
      })
      const viewport = await withPageOperation(this.page, () => pageGeometry(this.page, this.session))
      await this.session.send('Page.startScreencast', { format: 'jpeg', quality: this.options().quality, maxWidth: Math.ceil(viewport.width * viewport.scale), maxHeight: Math.ceil(viewport.height * viewport.scale), everyNthFrame: 1 })
      if (!this.disposed) this.mode('live')
    } catch { this.degrade() }
    if (this.disposed) return
    await this.capture()
    if (!this.disposed) this.timer = setInterval(() => this.tick(), 25)
  }

  private async measureFrame(): Promise<void> {
    if (this.measuring || this.disposed || !this.session) return
    this.measuring = true
    try {
      while (this.pendingFrame && !this.disposed) {
        const frame = this.pendingFrame
        this.pendingFrame = undefined
        const view = await withPageOperation(this.page, () => pageGeometry(this.page, this.session)).catch(() => undefined)
        const m = frame.metadata
        const width = m.deviceWidth / m.pageScaleFactor, height = m.deviceHeight / m.pageScaleFactor
        // 截图期间可能排入临时原生窗口尺寸的帧，恢复后的实际度量不匹配时丢弃。
        if (!view || Math.abs(width - view.width) > 1 || Math.abs(height - view.height) > 1) continue
        this.offer(frame.data, { width, height, offsetX: view.offsetX, offsetY: view.offsetY, scale: m.pageScaleFactor })
      }
    } finally { this.measuring = false }
  }
  private offer(data: string, geometry?: PageGeometry): void {
    if (this.disposed) return
    this.lastData = data
    this.mailbox.offer({ ...this.target, sequence: this.nextSequence(), data, geometry })
  }
  private degrade(): void {
    if (this.disposed || this.fallback) return
    this.fallback = true
    this.mode('fallback')
    void this.session?.send('Page.stopScreencast').catch(() => undefined)
  }
  private async capture(probe = false): Promise<void> {
    if (this.capturing || this.disposed || this.page.isClosed()) return
    this.capturing = true
    this.lastCapture = Date.now()
    try {
      const { geometry, data } = await pageScreenshot(this.page, this.options().quality, this.session)
      if (probe && data !== this.lastData) this.degrade()
      this.offer(data, geometry)
    } catch { /* 页面导航或关闭期间的短暂截图失败，下一轮重试。 */ } finally { this.capturing = false }
  }
  private tick(): void {
    if (this.disposed) return
    const now = Date.now()
    const fps = this.fallback ? Math.min(5, this.options().fps) : this.options().fps
    if (this.fallback && now - this.lastCapture >= 1000 / fps) void this.capture()
    else if (!this.fallback && now - this.lastReceived > 8000 && now - this.lastCapture > 8000) void this.capture(true)
    if (now - this.lastSent >= 1000 / fps) {
      const frame = this.mailbox.take()
      if (frame) { this.lastSent = now; this.send(frame) }
    }
  }
  async stop(): Promise<void> {
    this.disposed = true; this.pendingFrame = undefined
    if (this.timer) clearInterval(this.timer)
    this.mailbox.clear()
    if (this.session) {
      await this.session.send('Page.stopScreencast').catch(() => undefined)
      await this.session.detach().catch(() => undefined)
    }
  }
}
