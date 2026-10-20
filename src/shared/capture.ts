import { z } from 'zod'
import { proxyCredentialsSchema, proxySchema } from './browser-options'

const port = z.number().int().min(1024).max(65535)
const ip = z.string().trim().pipe(z.union([z.ipv4(), z.ipv6()]))
export const captureSettingsSchema = z.object({
  port: port.default(8899), autoStart: z.boolean().default(false), https: z.boolean().default(true),
  lan: z.boolean().default(false), allowedIps: z.array(ip).max(64).default([]),
  upstream: proxySchema.optional(), allowMcp: z.boolean().default(false), allowScripts: z.boolean().default(false)
}).strict().prefault({})
export type CaptureSettings = z.output<typeof captureSettingsSchema>
export const captureGrantSchema = z.enum(['none', 'read', 'control'])
export type CaptureGrant = z.infer<typeof captureGrantSchema>
export const captureConfigSchema = z.object({ settings: captureSettingsSchema, credentialId: z.uuid().optional(), grants: z.record(z.uuid(), captureGrantSchema).default({}) }).prefault({})
export type CaptureConfig = z.output<typeof captureConfigSchema>
export const captureQuerySchema = z.object({
  siteId: z.uuid().optional(), external: z.boolean().optional(), url: z.string().max(2048).optional(),
  method: z.string().max(32).optional(), status: z.number().int().min(100).max(999).optional(),
  from: z.number().nonnegative().optional(), to: z.number().nonnegative().optional(),
  cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(50)
}).strict()
export type CaptureQuery = z.input<typeof captureQuerySchema>
export type CaptureSource = { id: string; siteId?: string; generation?: string; name: string }
export type CaptureState = {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; port: number; pending: boolean
  generation?: string; error?: string; count: number; sites: string[]; addresses: string[]; fingerprint?: string
}
export type CaptureRecord = { id: string; source: CaptureSource; url: string; method: string; status?: number; startedAt: number; endedAt?: number; error?: string }
export type CapturePage = { items: CaptureRecord[]; cursor?: string; generation: string }
export type CaptureBody = { text?: string; base64?: string; encoding?: string; contentEncoding?: string; decoded: boolean; pending: boolean; truncated: boolean; unavailable: boolean; size: number; wireSize: number }
export type CaptureDetail = CaptureRecord & {
  request: { headers: { name: string; value: string }[]; body: CaptureBody }
  response: { headers: { name: string; value: string }[]; body: CaptureBody }
}
export const captureOpSchema = z.enum(['status', 'query', 'get', 'start', 'stop'])
export type CaptureOp = z.infer<typeof captureOpSchema>
export const CAPTURE_REQUEST_TIMEOUT = 15000
export const captureRequestSchema = z.object({ type: z.literal('capture'), id: z.uuid(), op: captureOpSchema, payload: z.unknown(), deadline: z.number().finite().optional() })
export type CaptureRequest = z.infer<typeof captureRequestSchema>
export type CaptureReply = { type: 'captureReply'; id: string } & ({ ok: true; value: unknown } | { ok: false; error: string })
export const captureProcessRequestSchema = z.discriminatedUnion('op', [
  z.object({ id: z.uuid(), op: z.literal('start'), directory: z.string(), settings: captureSettingsSchema, credentials: proxyCredentialsSchema.optional(), generation: z.uuid() }),
  z.object({ id: z.uuid(), op: z.literal('acquire'), source: z.object({ id: z.uuid(), siteId: z.uuid(), generation: z.uuid(), name: z.string().max(80) }), upstream: proxySchema.optional(), credentials: proxyCredentialsSchema.optional() }),
  z.object({ id: z.uuid(), op: z.literal('release'), sourceId: z.uuid() }),
  z.object({ id: z.uuid(), op: z.literal('query'), query: captureQuerySchema }),
  z.object({ id: z.uuid(), op: z.literal('get'), recordId: z.string().max(200), siteId: z.uuid().optional() }),
  z.object({ id: z.uuid(), op: z.enum(['stop', 'certificate']) })
])
export type CaptureProcessRequest = z.infer<typeof captureProcessRequestSchema>
export type CaptureReady = { port: number; uiPort: number; username: string; password: string; spki: string; fingerprint: string }
export type CaptureLease = { sourceId: string; port: number; spki: string; fingerprint: string; generation?: string }
export const captureViewSchema = z.object({ visible: z.boolean(), x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000), width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000) }).strict()
export type CaptureViewBounds = z.infer<typeof captureViewSchema>
export function captureSettingsFingerprint(settings: CaptureSettings, credentialId?: string): string {
  const { autoStart: _autoStart, allowMcp: _allowMcp, allowScripts: _allowScripts, ...effective } = settings
  return JSON.stringify({ ...effective, credentialId })
}
export const CAPTURE_CONTRACT = `抓包 API：桌面模块总开关及脚本本机授权开启后，octo.capture.status()、query({siteId?,external?,url?,method?,status?,from?,to?,limit?,cursor?})、get(id) 返回 Promise。行动和注入只读当前运行网站，不能扩大来源；沙箱可读全部来源。start()/stop() 另需 control 授权；有关联网站时不能停止代理，不修改 LAN、CA、自动启动或上游配置。
每个脚本跨实例每分钟最多 120 次访问，请求 15 秒超时，停止运行时拒绝在途请求。超时或停止不会回滚已执行的启停操作，应重新查询状态。授权立即生效且不随导出／导入／复制传播，改变脚本类型会清除授权；新脚本默认 none。这是宿主 API 访问约束，不是可信 Node.js 代码的安全沙箱。
报文含敏感信息，请勿输出 Cookie、Authorization 或代理凭据。记录仅存在于本次服务的有界内存缓存；旧代次、淘汰或清空后的 ID／游标会报错。from/to 为毫秒时间戳，每页默认 50、最多 100。正文各最多 1 MiB；size 为缓存正文对应长度，wireSize 为引擎记录的传输长度，encoding 为字符集、contentEncoding 为原压缩方式，decoded 表明是否已解压，pending 表明尚未结束。unavailable 表明正文不可用，truncated 表明不完整，不要将两者当成空正文；不支持的编码或二进制保留 base64。`
