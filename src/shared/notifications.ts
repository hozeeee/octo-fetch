import { z } from 'zod'

export const MAX_CHANNELS = 100
export const MAX_NOTIFICATION_LOGS = 1000
export const CHANNEL_LABELS = { dingtalk: '钉钉机器人', wecom: '企业微信机器人', feishu: '飞书机器人', smtp: 'SMTP 邮件', webhook: '通用 Webhook' } as const
export const channelKindSchema = z.enum(['dingtalk', 'wecom', 'feishu', 'smtp', 'webhook'])
export type ChannelKind = z.infer<typeof channelKindSchema>
export const channelKeySchema = z.string().min(2).max(64).regex(/^[a-z][a-z0-9_-]+$/, '调用标识须以小写英文开头，只含小写英文、数字、下划线或连字符')
export const channelDraftSchema = z.object({
  name: z.string().trim().min(1).max(80), key: channelKeySchema, kind: channelKindSchema,
  enabled: z.boolean().default(true), prefix: z.string().max(500).default('')
}).strict()
export type ChannelDraft = z.output<typeof channelDraftSchema>
export const channelSchema = channelDraftSchema.extend({ id: z.uuid(), credentialId: z.uuid(), createdAt: z.string(), updatedAt: z.string() })
export type NotificationChannel = z.infer<typeof channelSchema>
const httpUrl = z.string().trim().max(4096).url().refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
  } catch { return false }
}, '请输入不含账号、密码和片段的 HTTP(S) 地址')
const officialUrl = (kind: 'dingtalk' | 'wecom' | 'feishu') => httpUrl.refine((value) => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.port) return false
  if (kind === 'dingtalk') return url.hostname === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && Boolean(url.searchParams.get('access_token')) && [...url.searchParams.keys()].every((key) => key === 'access_token')
  if (kind === 'wecom') return url.hostname === 'qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send' && Boolean(url.searchParams.get('key')) && [...url.searchParams.keys()].every((key) => key === 'key')
  return url.hostname === 'open.feishu.cn' && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname) && !url.search
}, '请使用该平台官方 HTTPS 机器人 Webhook 地址')
const secret = z.string().min(1).max(4096)
const mailbox = z.email().max(254)
const forbiddenHeaders = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'trailer', 'te', 'expect', 'proxy-authorization', 'proxy-connection', 'cookie', 'set-cookie'])
export const notificationHeadersSchema = z.array(z.object({
  name: z.string().min(1).max(100).regex(/^[!#$%&'*+.^\w`|~-]+$/).refine((value) => !forbiddenHeaders.has(value.toLowerCase()), '不允许该传输控制或 Cookie Header'),

  value: z.string().max(4096).regex(/^[^\r\n\0]*$/)
}).strict()).max(30).refine((items) => new Set(items.map((item) => item.name.toLowerCase())).size === items.length, 'Header 名称不能重复')
const smtpFields = {
  host: z.string().trim().min(1).max(253).regex(/^[a-z0-9.:-]+$/i), port: z.number().int().min(1).max(65535),

  security: z.enum(['tls', 'starttls']), username: z.string().min(1).max(320).regex(/^[^\r\n\0]*$/), password: secret,
  from: mailbox, to: z.array(mailbox).min(1).max(50), cc: z.array(mailbox).max(50).default([])
}
export const notificationConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dingtalk'), url: officialUrl('dingtalk'), secret: secret.optional() }).strict(),
  z.object({ kind: z.literal('wecom'), url: officialUrl('wecom') }).strict(),
  z.object({ kind: z.literal('feishu'), url: officialUrl('feishu'), secret: secret.optional() }).strict(),
  z.object({ kind: z.literal('smtp'), ...smtpFields }).strict(),
  z.object({ kind: z.literal('webhook'), url: httpUrl, headers: notificationHeadersSchema.default([]), allowHttp: z.boolean().default(false) }).strict()
]).refine((value) => value.kind !== 'webhook' || value.allowHttp || value.url.startsWith('https:'), 'HTTP 明文连接需要显式允许')
export type NotificationConfig = z.output<typeof notificationConfigSchema>
// 省略敏感字段表示保留；null 显式清除可选密钥或 Header。
export const notificationPatchSchema = z.object({
  url: httpUrl.optional(), secret: secret.nullable().optional(), password: secret.optional(),
  headers: notificationHeadersSchema.nullable().optional(), allowHttp: z.boolean().optional(),
  host: smtpFields.host.optional(), port: smtpFields.port.optional(), security: smtpFields.security.optional(),
  username: smtpFields.username.optional(), from: mailbox.optional(), to: smtpFields.to.optional(), cc: z.array(mailbox).max(50).optional()
}).strict()
export type NotificationPatch = z.infer<typeof notificationPatchSchema>
export type NotificationDetail = {
  channel: NotificationChannel; settings: NotificationPatch
  configured: { url: boolean; secret: boolean; password: boolean; headers: boolean }
}
export const notificationMessageSchema = z.object({
  title: z.string().max(200).default(''),
  content: z.string().min(1).max(16384).refine((text) => new TextEncoder().encode(text).length <= 16384, '正文不能超过 16 KiB UTF-8')
}).strict()
export type NotificationMessage = z.output<typeof notificationMessageSchema>
export const notificationRequestSchema = z.object({
  id: z.uuid(), targets: z.array(channelKeySchema).min(1).max(10), message: notificationMessageSchema
}).strict()
export type NotificationRequest = z.output<typeof notificationRequestSchema>
export type NotifyWorkerMessage = { type: 'notify'; request: NotificationRequest }
export const notificationSourceSchema = z.object({ kind: z.enum(['action', 'injection', 'sandbox', 'test']), scriptId: z.uuid().optional(), runId: z.uuid().optional(), siteId: z.uuid().optional(), tabId: z.uuid().optional() }).strict()
export type NotificationSource = z.infer<typeof notificationSourceSchema>
export const NOTIFICATION_STATUS = { queued: '排队中', sending: '发送中', accepted: '服务端已受理', failed: '失败', skipped: '已跳过', interrupted: '已中断', unknown: '结果未知' } as const
export const notificationStatusSchema = z.enum(['queued', 'sending', 'accepted', 'failed', 'skipped', 'interrupted', 'unknown'])
export type NotificationStatus = z.infer<typeof notificationStatusSchema>
export const notificationLogSchema = z.object({
  id: z.uuid(), submissionId: z.uuid(), channelId: z.uuid().optional(), key: channelKeySchema, name: z.string().max(80),
  title: z.string().max(200), source: notificationSourceSchema, createdAt: z.string(), startedAt: z.string().optional(), endedAt: z.string().optional(),
  status: notificationStatusSchema, duration: z.number().nonnegative().optional(), code: z.string().max(100).optional(), error: z.string().max(500).optional(), count: z.number().int().positive().default(1)
}).strict()
export type NotificationLog = z.output<typeof notificationLogSchema>
export const notificationQuerySchema = z.object({
  key: channelKeySchema.optional(), status: notificationStatusSchema.optional(), kind: notificationSourceSchema.shape.kind.optional(),
  runId: z.uuid().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20)
}).strict()
export type NotificationQuery = z.input<typeof notificationQuerySchema>
export type NotificationPage = { items: NotificationLog[]; total: number }
export type ChannelSummary = Omit<NotificationChannel, 'credentialId' | 'prefix'> & { last?: Pick<NotificationLog, 'createdAt' | 'status'> }
export const notificationTerminal = (status: NotificationStatus) => status !== 'queued' && status !== 'sending'
export const NOTIFICATION_TEMPLATE = `// 在通知管理中创建 ops 通道；提交不代表送达，最终结果查看通知日志。
octo.notify('ops', { title: '运行提醒', content: '需要通知的业务内容' });`
export const NOTIFICATION_CONTRACT = `通知：行动、注入和沙箱都可调用 octo.notify(target, message): void。target 为通知管理中的稳定 key 或最多 10 个 key 的数组；message 为正文字符串或 {title?,content}。无默认群发；不要传地址、密钥或收件人。无需 await，不等待网络；失败独立记日志，不改变脚本/任务结果。标题最多 200 字符、正文最多 16 KiB UTF-8，机器人还受平台字节限制。通过 list_notification_channels 查通道摘要、read_notification_logs 按 runId 查最终投递结果。返回不代表成功；超时可能已送达，不自动重试。已接收通知不随脚本结束取消，应用退出后不续发。授权运行脚本意味着允许向指定通道发送正文。page.evaluate 网页环境没有 octo.notify。`
