import { z } from 'zod'

export const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false }
export const MAX_COORDINATE = 100000
// HTTP 字段拒绝控制字符，防止换行注入。
const cleanText = z.string().refine((text) => ![...text].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)), '不能包含换行或控制字符')
export const userAgentSchema = cleanText.pipe(z.string().trim().max(4096, '不能超过 4096 个字符'))
const optionalText = userAgentSchema.optional()
export const viewportSchema = z.object({
  width: z.number().int().min(240).max(3840).default(1280), height: z.number().int().min(240).max(3840).default(800),
  deviceScaleFactor: z.number().min(0.5).max(3).default(1), isMobile: z.boolean().default(false),
  hasTouch: z.boolean().default(false), isLandscape: z.boolean().default(false)
}).strict().refine((v) => v.width * v.height * v.deviceScaleFactor ** 2 <= 32000000, '渲染总像素不能超过 3200 万')
const brandSchema = z.object({ brand: cleanText.pipe(z.string().min(1).max(100)), version: cleanText.pipe(z.string().min(1).max(100)) }).strict()
export const userAgentMetadataSchema = z.object({
  brands: z.array(brandSchema).max(10).optional(), fullVersionList: z.array(brandSchema).max(10).optional(),
  platform: cleanText.pipe(z.string().max(100)), platformVersion: cleanText.pipe(z.string().max(100)),
  architecture: cleanText.pipe(z.string().max(100)), model: cleanText.pipe(z.string().max(100)), mobile: z.boolean(),
  bitness: cleanText.pipe(z.string().max(20)).optional(), wow64: z.boolean().optional()
}).strict()
const reservedHeaders = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'proxy-connection', 'user-agent', 'accept-language'])
export const extraHeadersSchema = z.array(z.object({
  name: z.string().trim().min(1).max(256).regex(/^[!#$%&'*+.^\w`|~-]+$/, '请求头名称无效').refine((name) => !reservedHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-ch-ua'), '该请求头由浏览器或登录态管理'),
  value: cleanText.refine((value) => new TextEncoder().encode(value).length <= 8192, '请求头值不能超过 8 KiB')
}).strict()).max(50).superRefine((headers, ctx) => {
  if (new Set(headers.map((h) => h.name.toLowerCase())).size !== headers.length) ctx.addIssue({ code: 'custom', message: '请求头名称不能重复' })
  if (headers.reduce((n, h) => n + new TextEncoder().encode(h.name + h.value).length, 0) > 32768) ctx.addIssue({ code: 'custom', message: '请求头总量不能超过 32 KiB' })
})
export const proxySchema = z.object({
  server: cleanText.pipe(z.string().trim().max(2048)).refine((value) => {
    try { const url = new URL(value); return ['http:', 'https:', 'socks5:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname) } catch { return false }
  }, '请输入不含账号密码的 HTTP、HTTPS 或 SOCKS5 代理地址'),
  bypass: z.array(z.string().trim().min(1).max(256).regex(/^[\w*.:/<>[\]-]+$/, '代理绕过规则无效')).max(50).default([])
}).strict()
export const proxyCredentialsSchema = z.object({ username: cleanText.pipe(z.string().min(1).max(512)), password: cleanText.pipe(z.string().max(2048)) }).strict()
export type ProxyCredentials = z.infer<typeof proxyCredentialsSchema>
export type DevicePreset = 'desktop' | 'android' | 'iphone' | 'ipad' | 'custom'
type DeviceOptions = { preset: DevicePreset; viewport: z.output<typeof viewportSchema>; userAgent?: string; platform?: string; userAgentMetadata?: z.output<typeof userAgentMetadataSchema> }
export const browserOptionsSchema = z.object({
  preset: z.enum(['desktop', 'android', 'iphone', 'ipad', 'custom']).default('desktop'),
  viewport: viewportSchema.optional(), userAgent: optionalText, platform: optionalText,
  userAgentMetadata: userAgentMetadataSchema.optional(),
  locale: z.string().trim().max(100).refine((value) => { try { return !value || Intl.getCanonicalLocales(value).length === 1 } catch { return false } }, '语言必须是有效的 BCP 47 标签，例如 zh-CN').optional(),
  // eslint-disable-next-line no-new -- 构造 DateTimeFormat 以校验时区是否受支持。
  timezone: z.string().trim().max(100).refine((value) => { try { if (value) new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }, '请输入有效的 IANA 时区，例如 Asia/Shanghai').optional(),
  geolocation: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).default(0) }).strict().optional(),
  javaScriptEnabled: z.boolean().default(true), cacheEnabled: z.boolean().default(true),
  navigationTimeout: z.number().int().min(10).max(120).optional(), extraHTTPHeaders: extraHeadersSchema.default([]),
  headless: z.boolean().default(true), acceptInsecureCerts: z.boolean().default(false), slowMo: z.number().int().min(0).max(500).default(0),
  proxy: proxySchema.optional()
}).strict().transform((value) => {
  const device = devicePreset(value.preset, '')
  const customUA = value.userAgent !== undefined && !isPresetUserAgent(value.userAgent, device.userAgent)
  return { ...device, ...(customUA ? { platform: undefined, userAgentMetadata: undefined } : {}), ...value, viewport: value.viewport ?? device.viewport }
})
export type BrowserOptions = z.output<typeof browserOptionsSchema>
export type BrowserOptionsDraft = z.input<typeof browserOptionsSchema>
export type BrowserConnectionOptions = Pick<BrowserOptions, 'slowMo' | 'acceptInsecureCerts'> & { navigationTimeout: number }
export type PageGeometry = { width: number; height: number; offsetX: number; offsetY: number; scale: number }
export const DEVICE_LABELS = { desktop: '桌面默认', android: 'Android 手机 · Pixel 5', iphone: 'iPhone 13', ipad: 'iPad', custom: '自定义' }
export function devicePreset(preset: DevicePreset, chromeVersion: string): DeviceOptions {
  const base = { preset, viewport: { ...DEFAULT_VIEWPORT }, userAgent: undefined, platform: undefined, userAgentMetadata: undefined }
  if (preset === 'desktop' || preset === 'custom') return base
  const viewport = { ...DEFAULT_VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: preset === 'ipad' ? 2 : 3 }
  if (preset === 'android') {
    const version = /^\d+\.\d+\.\d+\.\d+$/.test(chromeVersion) ? chromeVersion : '152.0.0.0'
    const major = version.split('.')[0]
    return { ...base, viewport: { ...viewport, width: 393, height: 851 }, platform: 'Linux armv8l', userAgent: `Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`, userAgentMetadata: { brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }], fullVersionList: [{ brand: 'Chromium', version }, { brand: 'Google Chrome', version }], platform: 'Android', platformVersion: '11.0.0', architecture: 'arm', model: 'Pixel 5', mobile: true } }
  }
  return preset === 'iphone'
    ? { ...base, viewport: { ...viewport, width: 390, height: 844 }, platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1' }
    : { ...base, viewport: { ...viewport, width: 768, height: 1024 }, platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 11_0 like Mac OS X) AppleWebKit/604.1.34 (KHTML, like Gecko) Version/11.0 Mobile/15A5341f Safari/604.1' }
}
export function isPresetUserAgent(value: string, preset?: string): boolean {
  return value.replace(/Chrome\/[\d.]+/, 'Chrome/V') === preset?.replace(/Chrome\/[\d.]+/, 'Chrome/V')
}
export function browserOptionsFingerprint(raw: BrowserOptionsDraft, credentialId?: string, defaultUserAgent = ''): string {
  const value = browserOptionsSchema.parse(raw)
  // 预设名称只用于显示；空字符串与未设置具有相同含义。
  const { preset: _preset, ...options } = value
  return JSON.stringify({ ...options, userAgent: value.userAgent || defaultUserAgent || undefined, platform: value.platform || undefined, locale: value.locale || undefined, timezone: value.timezone || undefined, proxy: value.proxy ? { ...value.proxy, server: new URL(value.proxy.server).href, bypass: [...value.proxy.bypass].sort() } : undefined, extraHTTPHeaders: value.extraHTTPHeaders.map((h) => ({ name: h.name.toLowerCase(), value: h.value })).sort((a, b) => a.name.localeCompare(b.name)), credentialId })
}
export function browserOptionsSummary(options: BrowserOptions) {
  return `${options.viewport.isMobile ? '移动端' : '桌面端'} · ${options.viewport.width} × ${options.viewport.height} · DPR ${options.viewport.deviceScaleFactor}`
}
