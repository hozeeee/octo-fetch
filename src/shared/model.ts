import type { BrowserOptions, PageGeometry } from './browser-options'
import type { CaptureDetail, CapturePage, CaptureQuery, CaptureState, CaptureViewBounds } from './capture'
import type { DataPage, DataQuery, DataSummary } from './data-store'
import type { InjectionState } from './injections'
import type { ChannelSummary, NotificationDetail, NotificationPage, NotificationQuery } from './notifications'
import type { ActiveScriptRun, InstallResult, SavedScript, ScriptRun, ScriptSummary } from './scripts'
import type { ActiveTaskRun, TaskRun } from './tasks'
import { z } from 'zod'
import { browserOptionsSchema, MAX_COORDINATE, proxyCredentialsSchema, userAgentSchema } from './browser-options'
import { captureConfigSchema, captureGrantSchema, captureSettingsSchema } from './capture'
import { collectionSchema, dataFilterSchema } from './data-store'
import { injectionBindingsSchema } from './injections'
import { channelDraftSchema, channelSchema, MAX_CHANNELS, notificationPatchSchema } from './notifications'
import { runRequestSchema, scriptDraftSchema } from './scripts'
import { MAX_TASKS, taskDraftSchema, taskSchema } from './tasks'

export const VIEWPORT = { width: 1280, height: 800 } as const
export const MAX_TABS = 8
export const idSchema = z.uuid()
export const urlSchema = z.string().trim().max(4096).refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}, '请输入不含账号密码的 HTTP / HTTPS 网址')
export const DEFAULT_SANDBOX_REGISTRY = 'https://registry.npmjs.org/'
export const npmRegistrySchema = z.string().trim().min(1).max(2048).url().refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, '请输入不含账号密码、查询参数或片段的 HTTP / HTTPS npm registry 地址')
export const settingsSchema = z.object({
  maxRunning: z.number().int().min(1),
  gridFps: z.number().int().min(1).max(5),
  focusFps: z.number().int().min(5).max(30),
  quality: z.number().int().min(40).max(90),
  navigationTimeout: z.number().int().min(10).max(120),
  defaultUserAgent: userAgentSchema.default(''),
  sandboxRegistry: npmRegistrySchema.default(DEFAULT_SANDBOX_REGISTRY)
}).strict()
export type Settings = z.infer<typeof settingsSchema>
export const DEFAULT_SETTINGS: Settings = { maxRunning: 4, gridFps: 2, focusFps: 15, quality: 70, navigationTimeout: 30, defaultUserAgent: '', sandboxRegistry: DEFAULT_SANDBOX_REGISTRY }
export const MCP_LEVELS = ['read', 'operate', 'full'] as const
export const mcpLevelSchema = z.enum(MCP_LEVELS)
export type McpLevel = z.infer<typeof mcpLevelSchema>
// 等级递增包含：三级令牌可以调用二级和一级工具。
export const MCP_LEVEL_LABELS: Record<McpLevel, string> = { read: '一级 · 只读', operate: '二级 · 低危操作', full: '三级 · 全部权限' }
export const MAX_TOKENS = 32
export const mcpSettingsSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }).strict()
export type McpSettings = z.infer<typeof mcpSettingsSchema>
export const DEFAULT_MCP_SETTINGS: McpSettings = { enabled: false, port: 8787 }
export const tokenDraftSchema = z.object({ alias: z.string().trim().min(1).max(40), level: mcpLevelSchema }).strict()
export type TokenDraft = z.infer<typeof tokenDraftSchema>
// config.json 只保存指纹与统计；明文令牌存在加密文件里。
export const tokenSchema = z.object({
  id: idSchema, alias: tokenDraftSchema.shape.alias, level: mcpLevelSchema, enabled: z.boolean(),
  prefix: z.string().min(4).max(24), hash: z.string().length(64).regex(/^[0-9a-f]+$/, '令牌指纹不合法'),
  createdAt: z.string(), calls: z.number().int().nonnegative().default(0), errors: z.number().int().nonnegative().default(0),
  denied: z.number().int().nonnegative().default(0), lastUsedAt: z.string().optional(), lastTool: z.string().max(60).optional()
})
export type McpToken = z.infer<typeof tokenSchema>
export const mcpConfigSchema = z.object({ settings: mcpSettingsSchema, tokens: z.array(tokenSchema).max(MAX_TOKENS) })
export type McpConfig = z.infer<typeof mcpConfigSchema>
export type McpState = { running: boolean; port: number; endpoint: string; error?: string }
export const siteDraftSchema = z.object({ name: z.string().trim().min(1).max(80), url: urlSchema, injections: injectionBindingsSchema, browserOptions: browserOptionsSchema.prefault({}), captureEnabled: z.boolean().default(false) }).strict()
export type SiteDraft = z.input<typeof siteDraftSchema>
export const siteSchema = siteDraftSchema.extend({
  id: idSchema, order: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  cookieUpdatedAt: z.string().optional(), cookieCount: z.number().int().nonnegative().default(0),
  pendingCookies: z.boolean().default(false), proxyCredentialId: idSchema.optional()
})
export type Site = z.infer<typeof siteSchema>
export const configSchema = z.object({
  schemaVersion: z.literal(1), sites: z.array(siteSchema), settings: settingsSchema, capture: captureConfigSchema,
  mcp: mcpConfigSchema.default(() => ({ settings: { ...DEFAULT_MCP_SETTINGS }, tokens: [] })),
  tasks: z.array(taskSchema).max(MAX_TASKS).default([]),
  notifications: z.array(channelSchema).max(MAX_CHANNELS).refine((items) => new Set(items.map((item) => item.key)).size === items.length && new Set(items.map((item) => item.id)).size === items.length, '通知通道标识不能重复').default([])
})
export type Config = z.infer<typeof configSchema>
export const cookieSchema = z.object({
  // eslint-disable-next-line no-control-regex -- 明确拒绝 HTTP Cookie 中的控制字符。
  name: z.string().min(1).max(1024).regex(/^[^\s=;\x00-\x1F\x7F]+$/, 'Cookie 名称不合法'),

  value: z.string().max(16384).regex(/^[^\r\n\0]*$/, 'Cookie 值不合法'),
  domain: z.string().min(1).max(253).regex(/^[\w.\-[\]:]+$/, '域名不合法'),
  path: z.string().max(2048).startsWith('/'),
  expires: z.number().finite().min(-1).optional(),
  httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(),
  sourceScheme: z.enum(['Unset', 'NonSecure', 'Secure']).optional(),
  partitionKey: z.union([z.string().url(), z.object({ sourceOrigin: z.string().url(), hasCrossSiteAncestor: z.boolean().optional() }).strict()]).optional()
}).strict().superRefine((cookie, ctx) => {
  if (cookie.sameSite === 'None' && !cookie.secure) ctx.addIssue({ code: 'custom', message: 'SameSite=None 要求 secure=true' })
  if (cookie.name.startsWith('__Secure-') && !cookie.secure) ctx.addIssue({ code: 'custom', message: '__Secure- Cookie 要求 secure=true' })
  if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.'))) {
    ctx.addIssue({ code: 'custom', message: '__Host- Cookie 要求安全、主机限定且 path=/' })
  }
})
export type Cookie = z.infer<typeof cookieSchema>
export const cookieChangesSchema = z.object({
  upsert: z.array(cookieSchema).max(3000), remove: z.array(cookieSchema).max(3000)
}).strict()
export type CookieChanges = z.infer<typeof cookieChangesSchema>
export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export type Tab = { id: string; title: string; url: string; loading: boolean; error?: string; geometry?: PageGeometry }
export type RemoteDialog = { id: string; type: string; message: string; defaultValue: string }
export type Runtime = {
  siteId: string; generation: string; status: RuntimeStatus; tabs: Tab[]; activeTabId?: string
  injections?: InjectionState[]; injectionFingerprint?: string; injectionsPending?: boolean
  viewport?: BrowserOptions['viewport']; browserOptionsPending?: boolean; captureActive?: boolean; capturePending?: boolean; captureError?: boolean
  error?: string; warning?: string; streamMode?: 'live' | 'fallback' | 'paused'; dialog?: RemoteDialog
}
export type Snapshot = {
  scripts: ScriptSummary[]; scriptRuns: ActiveScriptRun[]; taskRuns: ActiveTaskRun[]; notifications: ChannelSummary[]
  config: Config; runtimes: Runtime[]; info: { version: string; nodeVersion?: string; browserVersion: string; dataDir: string; arch: string }; warnings: string[]; mcp: McpState; data: DataSummary; capture: CaptureState
}
export type Frame = { siteId: string; generation: string; tabId: string; sequence: number; data: string; geometry?: PageGeometry }
export type FrameAck = Pick<Frame, 'siteId' | 'generation' | 'tabId' | 'sequence'>
export const targetSchema = z.object({ siteId: idSchema, tabId: idSchema, generation: idSchema }).strict()
export type Target = z.infer<typeof targetSchema>
const point = { x: z.number().finite().min(0).max(MAX_COORDINATE), y: z.number().finite().min(0).max(MAX_COORDINATE) }
export const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), ...point }),
  z.object({ type: z.enum(['down', 'up']), ...point, button: z.enum(['left', 'middle', 'right']), clickCount: z.number().int().min(1).max(3) }),
  z.object({ type: z.literal('wheel'), ...point, deltaX: z.number().finite().min(-10000).max(10000), deltaY: z.number().finite().min(-10000).max(10000) }),
  z.object({ type: z.enum(['keyDown', 'keyUp']), key: z.string().min(1).max(40) }),
  z.object({ type: z.literal('text'), text: z.string().max(100000) }),
  z.object({ type: z.enum(['release', 'copy', 'paste', 'selectAll']) })
])
export type RemoteInput = z.infer<typeof inputSchema>
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture.save'), settings: captureSettingsSchema, credentials: proxyCredentialsSchema.nullable().optional() }),
  z.object({ type: z.enum(['capture.start', 'capture.stop', 'capture.restart', 'capture.certificate.export', 'capture.certificate.reset']) }),
  z.object({ type: z.literal('capture.site'), siteId: idSchema, enabled: z.boolean() }),
  z.object({ type: z.literal('capture.grant'), scriptId: idSchema, grant: captureGrantSchema }),
  z.object({ type: z.literal('notification.save'), id: idSchema.optional(), draft: channelDraftSchema, settings: notificationPatchSchema }),
  z.object({ type: z.literal('notification.enable'), id: idSchema, enabled: z.boolean() }),
  z.object({ type: z.enum(['notification.delete', 'notification.test']), id: idSchema }),
  z.object({ type: z.literal('notification.logs.clear') }),
  z.object({ type: z.literal('script.save'), id: idSchema.optional(), draft: scriptDraftSchema }),
  z.object({ type: z.literal('script.run'), ...runRequestSchema.shape }),
  z.object({ type: z.enum(['script.delete', 'script.cancel', 'script.logs.clear', 'script.export']), id: idSchema }),
  z.object({ type: z.literal('script.import') }),
  z.object({ type: z.literal('site.save'), id: idSchema.optional(), draft: siteDraftSchema.extend({ injections: injectionBindingsSchema.removeDefault().optional(), browserOptions: browserOptionsSchema.optional(), captureEnabled: z.boolean().optional() }), proxyCredentials: proxyCredentialsSchema.nullable().optional() }),
  z.object({ type: z.enum(['site.delete', 'site.clear', 'browser.start', 'browser.stop', 'cookie.capture', 'cookie.restore']), siteId: idSchema }),
  z.object({ type: z.literal('settings.save'), settings: settingsSchema }),
  z.object({ type: z.literal('tab.new'), siteId: idSchema }),
  z.object({ type: z.enum(['tab.activate', 'tab.close']), ...targetSchema.shape }),
  z.object({ type: z.literal('tab.navigate'), ...targetSchema.shape, url: urlSchema }),
  z.object({ type: z.enum(['tab.back', 'tab.forward', 'tab.reload']), ...targetSchema.shape }),
  z.object({ type: z.literal('view'), siteId: idSchema.nullable(), visible: z.boolean() }),
  z.object({ type: z.literal('input'), ...targetSchema.shape, input: inputSchema }),
  z.object({ type: z.literal('cookie.apply'), siteId: idSchema, changes: cookieChangesSchema }),
  z.object({ type: z.literal('dialog.answer'), ...targetSchema.shape, dialogId: idSchema, accept: z.boolean(), text: z.string().max(10000).optional() }),
  z.object({ type: z.literal('data.open') }),
  z.object({ type: z.literal('data.delete'), id: idSchema }),
  z.object({ type: z.literal('data.clear'), collection: collectionSchema.optional() }),
  z.object({ type: z.literal('data.export'), filter: dataFilterSchema.optional() }),
  z.object({ type: z.literal('mcp.save'), settings: mcpSettingsSchema }),
  z.object({ type: z.literal('token.save'), id: idSchema, draft: tokenDraftSchema }),
  z.object({ type: z.literal('token.enable'), id: idSchema, enabled: z.boolean() }),
  z.object({ type: z.enum(['token.delete', 'token.rotate']), id: idSchema }),
  z.object({ type: z.literal('task.save'), id: idSchema.optional(), draft: taskDraftSchema }),
  z.object({ type: z.literal('task.enable'), id: idSchema, enabled: z.boolean() }),
  z.object({ type: z.enum(['task.run', 'task.cancel', 'task.delete', 'task.logs.clear']), id: idSchema })
])
export type Command = z.infer<typeof commandSchema>
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }
export type CookieView = { cookies: Cookie[]; pending: boolean; updatedAt?: string }
// 明文令牌只在生成和显式查看时经由独立通道返回，不进入常规状态快照。
export const secretSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), draft: tokenDraftSchema }),
  z.object({ type: z.literal('reveal'), id: idSchema })
])
export type SecretRequest = z.infer<typeof secretSchema>
export type TokenSecret = { id: string; secret: string }
export interface DesktopAPI {
  snapshot(): Promise<Reply<Snapshot>>
  command(command: Command): Promise<Reply<void>>
  script(id: string): Promise<Reply<SavedScript>>
  installDependencies(id: string): Promise<Reply<InstallResult>>
  scriptRuns(id: string): Promise<Reply<ScriptRun[]>>
  taskRuns(id: string): Promise<Reply<TaskRun[]>>
  notification(id: string): Promise<Reply<NotificationDetail>>
  notificationLogs(query: NotificationQuery): Promise<Reply<NotificationPage>>
  dataRecords(query: DataQuery): Promise<Reply<DataPage>>
  captureQuery(query: CaptureQuery): Promise<Reply<CapturePage>>
  captureDetail(id: string): Promise<Reply<CaptureDetail>>
  captureView(bounds: CaptureViewBounds): Promise<Reply<void>>
  cookies(siteId: string): Promise<Reply<CookieView>>
  secret(request: SecretRequest): Promise<Reply<TokenSecret>>
  acknowledge(frame: FrameAck): void
  onState(listener: (snapshot: Snapshot) => void): () => void
  onFrame(listener: (frame: Frame) => void): () => void
}
