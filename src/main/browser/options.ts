import type { CDPSession, Page } from 'puppeteer-core'
import type { BrowserConnectionOptions, BrowserOptions, PageGeometry } from '../../shared/browser-options'
import type { CaptureLease } from '../../shared/capture'
import { browserOptionsSchema, devicePreset, isPresetUserAgent } from '../../shared/browser-options'
import { SerialQueue } from '../storage/store'

export function resolveOptions(options: BrowserOptions, version: string, defaultUserAgent = ''): BrowserOptions {
  // 自动预设随附带 Chrome 更新；自定义值不做推测或改写。
  if (options.preset === 'android' && isPresetUserAgent(options.userAgent ?? '', devicePreset('android', version).userAgent)) {
    const device = devicePreset('android', version)
    const oldVersion = /Chrome\/([\d.]+)/.exec(options.userAgent ?? '')?.[1] ?? ''
    const automaticMetadata = JSON.stringify(options.userAgentMetadata) === JSON.stringify(devicePreset('android', oldVersion).userAgentMetadata)
    return browserOptionsSchema.parse({ ...options, userAgent: device.userAgent, userAgentMetadata: automaticMetadata ? device.userAgentMetadata : options.userAgentMetadata })
  }
  const resolved = browserOptionsSchema.parse(options)
  return { ...resolved, userAgent: resolved.userAgent || defaultUserAgent || undefined }
}
export function connectionOptions(options: BrowserOptions, defaultTimeout: number): BrowserConnectionOptions {
  return { slowMo: options.slowMo, acceptInsecureCerts: options.acceptInsecureCerts, navigationTimeout: options.navigationTimeout ?? defaultTimeout }
}
export function proxyArguments(options: BrowserOptions): string[] {
  if (!options.proxy) return []
  const server = new URL(options.proxy.server)
  return [`--proxy-server=${server.protocol}//${server.host}`, ...(options.proxy.bypass.length ? [`--proxy-bypass-list=${options.proxy.bypass.join(';')}`] : [])]
}
export function captureOptions(options: BrowserOptions, lease: CaptureLease): BrowserOptions {
  return { ...options, proxy: { server: `http://127.0.0.1:${lease.port}`, bypass: [...(options.proxy?.bypass || [])] } }
}
export function captureArguments(lease?: CaptureLease): string[] {
  return lease ? ['--disable-quic', `--ignore-certificate-errors-spki-list=${lease.spki}`] : []
}
export async function applyPageOptions(page: Page, options: BrowserOptions, defaultTimeout: number, popupSession?: CDPSession): Promise<void> {
  page.setDefaultNavigationTimeout((options.navigationTimeout ?? defaultTimeout) * 1000)
  if (popupSession) {
    // 弹窗可能已提交 POST；直接应用指标，避免 setViewport 自动刷新并重放请求。
    const v = options.viewport
    await popupSession.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: v.isMobile, screenOrientation: v.isLandscape ? { angle: 90, type: 'landscapePrimary' } : { angle: 0, type: 'portraitPrimary' } })
    await popupSession.send('Emulation.setTouchEmulationEnabled', { enabled: v.hasTouch })
  } else {
    await page.setViewport(options.viewport)
  }
  if (options.userAgent || options.platform || options.userAgentMetadata) await page.setUserAgent({ userAgent: options.userAgent || undefined, platform: options.platform || undefined, userAgentMetadata: options.userAgentMetadata })
  if (options.platform) {
    // Chrome 释放其他 CDP 会话时会重置 platform；文档级覆盖保持配置，可信注入仍可再次覆盖。
    const platform = (value: string) => { Object.defineProperty(Navigator.prototype, 'platform', { get: () => value, configurable: true }) }
    await page.evaluateOnNewDocument(platform, options.platform)
    await page.evaluate(platform, options.platform)
  }
  if (options.locale) await page.emulateLocale(options.locale)
  if (options.timezone) await page.emulateTimezone(options.timezone)
  if (options.geolocation) await page.setGeolocation(options.geolocation)
  await page.setJavaScriptEnabled(options.javaScriptEnabled)
  await page.setCacheEnabled(options.cacheEnabled)
  await page.setExtraHTTPHeaders(Object.fromEntries(options.extraHTTPHeaders.map((h) => [h.name, h.value])))
}
const pageOperations = new WeakMap<Page, SerialQueue>()
const capturingPages = new WeakSet<Page>()
export function withPageOperation<T>(page: Page, operation: () => Promise<T>): Promise<T> {
  let queue = pageOperations.get(page)
  if (!queue) { queue = new SerialQueue(); pageOperations.set(page, queue) }
  return queue.run(operation)
}
export function isPageCapturing(page: Page): boolean { return capturingPages.has(page) }
export function pageScreenshot(page: Page, quality: number, client?: CDPSession) {
  return withPageOperation(page, async () => {
    // Chrome 截图会短暂改写合成器缩放；输入及度量必须等截图恢复后执行。
    capturingPages.add(page)
    try {
      const geometry = await pageGeometry(page, client)
      const data = await page.screenshot({ type: 'jpeg', quality, encoding: 'base64', captureBeyondViewport: false })
      return { data, geometry }
    } finally { capturingPages.delete(page) }
  })
}
// 已持有页面操作队列的调用方使用此原始度量，避免重复入队。
export async function pageGeometry(page: Page, client?: CDPSession): Promise<PageGeometry> {
  const session = client || await page.createCDPSession()
  try {
    const { cssVisualViewport: view } = await session.send('Page.getLayoutMetrics')
    return { width: view.clientWidth, height: view.clientHeight, offsetX: view.offsetX, offsetY: view.offsetY, scale: view.scale }
  } finally { if (!client) await session.detach() }
}
export function jpegSize(data: string): { width: number; height: number } {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xFFD8) throw new Error('截图格式无效')
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xFF) break
    const marker = bytes[offset + 1]
    const length = bytes.readUInt16BE(offset + 2)
    if ([0xC0, 0xC1, 0xC2].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    if (length < 2) break
    offset += length + 2
  }
  throw new Error('无法读取截图尺寸')
}
export function validatePoint(input: { x: number; y: number }, geometry: PageGeometry) {
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= geometry.width || input.y >= geometry.height) throw new Error('坐标超出当前页面可见区域，请重新截图确认位置')
}
