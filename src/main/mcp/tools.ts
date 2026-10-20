import type { McpLevel } from '../../shared/model'
import type { BrowserManager } from '../browser/manager'
import type { ScriptRunner } from '../scripts/runner'
import { z } from 'zod'
import { browserOptionsSchema, browserOptionsSummary, MAX_COORDINATE, proxyCredentialsSchema, userAgentSchema } from '../../shared/browser-options'
import { cookieChangesSchema, idSchema, MAX_TABS, npmRegistrySchema, settingsSchema, siteDraftSchema, urlSchema, VIEWPORT } from '../../shared/model'
import { CAPTURE_TOOLS } from './capture'
import { DATA_TOOLS } from './data'
import { SCRIPT_TOOLS } from './scripts'
import { TASK_TOOLS } from './tasks'

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type Tool = { name: string; level: McpLevel; description: string; input: Record<string, unknown>; run(manager: BrowserManager, args: unknown, scripts?: ScriptRunner): Promise<Content[]> }
type Schema = Record<string, unknown>

const object = (properties: Schema, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const SITE: Schema = { type: 'string', description: '网站配置 ID，来自 list_sites' }
const TAB: Schema = { type: 'string', description: '标签 ID，省略则操作当前标签' }
const X: Schema = { type: 'number', minimum: 0, maximum: MAX_COORDINATE, description: '当前可见区域 CSS 坐标 X，实际边界以 list_tabs / capture_screenshot 为准，不是图片像素' }
const Y: Schema = { type: 'number', minimum: 0, maximum: MAX_COORDINATE, description: '当前可见区域 CSS 坐标 Y，实际边界由目标页校验' }
const site = z.object({ site_id: idSchema }).strict()
const tab = z.object({ site_id: idSchema, tab_id: idSchema.optional() })
const point = { x: z.number().finite().min(0).max(MAX_COORDINATE), y: z.number().finite().min(0).max(MAX_COORDINATE) }
const report = (value: unknown): Content[] => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

function tool<T extends z.ZodType>(name: string, level: McpLevel, description: string, input: Schema, schema: T,
  run: (manager: BrowserManager, args: z.output<T>) => Promise<Content[]>): Tool {
  // 声明成 async：参数校验失败也走 Promise 拒绝，调用方只需处理一种错误路径。
  const hint = ['click', 'type_text', 'press_key', 'scroll'].includes(name) ? '重复流程请先查 list_scripts，读 script_guide 后用 save_script 固化为可复用能力。' : ''
  return { name, level, description: description + hint, input, run: async (manager, args) => run(manager, schema.parse(args ?? {})) }
}
// 导航和输入之后的结果都从运行状态里回读，让接入端看到真实的标题、网址和失败原因。
function tabState(manager: BrowserManager, siteId: string, tabId: string) {
  const runtime = manager.states().find((item) => item.siteId === siteId)
  const state = runtime?.tabs.find((item) => item.id === tabId)
  if (state?.error) throw new Error(state.error)
  return { tab_id: tabId, title: state?.title, url: state?.url, loading: state?.loading, dialog: runtime?.dialog?.message }
}

export const TOOLS: Tool[] = [
  ...SCRIPT_TOOLS,
  ...TASK_TOOLS,
  ...DATA_TOOLS,
  ...CAPTURE_TOOLS,
  tool('list_sites', 'read', '列出全部网站配置及其运行状态、标签数量和 Cookie 快照概况。', object({}), z.object({}).loose(), async (manager) => {
    const runtimes = manager.states()
    return report(manager.store.get().sites.map((item) => {
      const runtime = runtimes.find((entry) => entry.siteId === item.id)
      return {
        site_id: item.id, name: item.name, url: item.url, status: runtime?.status || 'stopped',
        tabs: runtime?.tabs.length || 0, cookie_count: item.cookieCount, cookie_updated_at: item.cookieUpdatedAt,
        pending_cookies: item.pendingCookies, error: runtime?.error, warning: runtime?.warning,
        injections: item.injections.map(({ scriptId, enabled }) => ({ scriptId, enabled })), injection_states: runtime?.injections, injections_pending: runtime?.injectionsPending,
        device_summary: browserOptionsSummary(item.browserOptions), browser_options_pending: runtime?.browserOptionsPending ?? false,
        browser_options: { preset: item.browserOptions.preset, viewport: item.browserOptions.viewport, locale: item.browserOptions.locale, timezone: item.browserOptions.timezone, headless: item.browserOptions.headless, acceptInsecureCerts: item.browserOptions.acceptInsecureCerts, slowMo: item.browserOptions.slowMo, javaScriptEnabled: item.browserOptions.javaScriptEnabled, cacheEnabled: item.browserOptions.cacheEnabled, navigationTimeout: item.browserOptions.navigationTimeout, custom_ua: Boolean(item.browserOptions.userAgent), geolocation_enabled: Boolean(item.browserOptions.geolocation), extra_header_count: item.browserOptions.extraHTTPHeaders.length, proxy_enabled: Boolean(item.browserOptions.proxy), proxy_auth_saved: Boolean(item.proxyCredentialId) }
      }
    }))
  }),
  tool('list_tabs', 'read', '列出某个配置当前打开的标签，包含当前标签和等待应答的对话框。', object({ site_id: SITE }, ['site_id']), site, async (manager, args) => {
    const runtime = manager.states().find((item) => item.siteId === args.site_id)
    if (!runtime) return report({ status: 'stopped', tabs: [] })
    return report({
      status: runtime.status, active_tab_id: runtime.activeTabId, dialog: runtime.dialog,
      tabs: await Promise.all(runtime.tabs.map(async (item) => ({ tab_id: item.id, title: item.title, url: item.url, loading: item.loading, error: item.error, css_visible_region: runtime.dialog ? item.geometry : await manager.geometry(args.site_id, item.id).catch(() => item.geometry) })))
    })
  }),
  tool('read_page', 'read', '读取标签当前内容，默认返回可见正文文本，需要结构时可取 HTML。', object({
    site_id: SITE, tab_id: TAB, format: { type: 'string', enum: ['text', 'html'], description: '默认 text' },
    max_length: { type: 'integer', minimum: 200, maximum: 200000, description: '返回内容上限，默认 20000 字符' }
  }, ['site_id']), tab.extend({ format: z.enum(['text', 'html']).default('text'), max_length: z.number().int().min(200).max(200000).default(20000) }).strict(),
  async (manager, args) => {
    const page = await manager.readPage(args.site_id, args.tab_id, args.format === 'html', args.max_length)
    return report({ tab_id: page.tabId, title: page.title, url: page.url, truncated: page.truncated, content: page.content })
  }),
  tool('capture_screenshot', 'read', '截取标签当前画面，返回 JPEG 图片；画质沿用全局配置。', object({ site_id: SITE, tab_id: TAB }, ['site_id']), tab.strict(), async (manager, args) => {
    const shot = await manager.screenshot(args.site_id, args.tab_id)
    return [...report({ tab_id: shot.tabId, image_pixels: shot.image, css_visible_region: shot.geometry, coordinate_note: '点击/滚动使用可见区域 CSS 坐标；图片坐标需分别乘以 CSS 宽高 / 图片宽高。DPR 与页面缩放已计入，不要再次乘除。' }), { type: 'image', data: shot.data, mimeType: 'image/jpeg' }]
  }),
  tool('get_settings', 'read', '读取全局配置：并发上限、帧率、画质、导航超时、默认 UA 及视口尺寸。', object({}), z.object({}).loose(), async (manager) => {
    return report({ ...manager.store.get().settings, viewport: VIEWPORT, viewport_description: '仅为默认桌面尺寸；每网站可独立配置，实际可见区域以 list_tabs / capture_screenshot 为准', max_tabs: MAX_TABS, running: manager.runningCount() })
  }),
  tool('start_site', 'operate', '启动某个配置的独立浏览器，加载已绑定的可信注入代码，并打开初始网址；配置注入需三级身份。', object({ site_id: SITE }, ['site_id']), site, async (manager, args) => {
    await manager.start(args.site_id)
    const runtime = manager.states().find((item) => item.siteId === args.site_id)
    return report({ status: runtime?.status, active_tab_id: runtime?.activeTabId, tabs: runtime?.tabs.length })
  }),
  tool('stop_site', 'operate', '停止某个配置的浏览器；登录目录和 Cookie 快照保留。', object({ site_id: SITE }, ['site_id']), site, async (manager, args) => {
    await manager.stop(args.site_id)
    return report('已停止该网站，登录数据仍保留。')
  }),
  tool('open_tab', 'operate', '在运行中的配置内新开标签，可同时导航到指定网址。', object({ site_id: SITE, url: { type: 'string', description: 'HTTP / HTTPS 网址，省略则留空白页' } }, ['site_id']),
    site.extend({ url: urlSchema.optional() }).strict(), async (manager, args) => {
      await manager.newTab(args.site_id)
      const target = await manager.agentFocus(args.site_id)
      if (args.url) await manager.navigate(target, 'navigate', args.url)
      return report(tabState(manager, args.site_id, target.tabId))
    }),
  tool('close_tab', 'operate', '关闭指定标签；关闭最后一个标签时会保留空白页。', object({ site_id: SITE, tab_id: { ...TAB, description: '标签 ID' } }, ['site_id', 'tab_id']),
    site.extend({ tab_id: idSchema }).strict(), async (manager, args) => {
      await manager.tabAction(manager.agentTarget(args.site_id, args.tab_id), 'close')
      return report('已关闭该标签。')
    }),
  tool('activate_tab', 'operate', '把指定标签切换为当前标签，实时画面也随之切换。', object({ site_id: SITE, tab_id: { ...TAB, description: '标签 ID' } }, ['site_id', 'tab_id']),
    site.extend({ tab_id: idSchema }).strict(), async (manager, args) => {
      const target = await manager.agentFocus(args.site_id, args.tab_id)
      return report(tabState(manager, args.site_id, target.tabId))
    }),
  tool('navigate', 'operate', '让标签打开指定网址，等待 DOM 就绪后返回标题与网址。', object({ site_id: SITE, tab_id: TAB, url: { type: 'string', description: 'HTTP / HTTPS 网址' } }, ['site_id', 'url']),
    tab.extend({ url: urlSchema }).strict(), async (manager, args) => {
      const target = await manager.agentFocus(args.site_id, args.tab_id)
      await manager.navigate(target, 'navigate', args.url)
      return report(tabState(manager, args.site_id, target.tabId))
    }),
  tool('go_history', 'operate', '对标签执行后退、前进或刷新。', object({ site_id: SITE, tab_id: TAB, action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['site_id', 'action']),
    tab.extend({ action: z.enum(['back', 'forward', 'reload']) }).strict(), async (manager, args) => {
      const target = await manager.agentFocus(args.site_id, args.tab_id)
      await manager.navigate(target, args.action)
      return report(tabState(manager, args.site_id, target.tabId))
    }),
  tool('capture_cookies', 'operate', '立即把运行中浏览器的 Cookie 存成加密快照。', object({ site_id: SITE }, ['site_id']), site, async (manager, args) => {
    await manager.captureCookies(args.site_id)
    const site = manager.store.site(args.site_id)
    return report({ cookie_count: site.cookieCount, cookie_updated_at: site.cookieUpdatedAt })
  }),
  tool('answer_dialog', 'operate', '应答网页的 alert / confirm / prompt 对话框，未应答的对话框会阻塞页面。',
    object({ site_id: SITE, accept: { type: 'boolean', description: '确认或取消' }, text: { type: 'string', description: 'prompt 的输入内容' } }, ['site_id', 'accept']),
    site.extend({ accept: z.boolean(), text: z.string().max(10000).optional() }).strict(), async (manager, args) => {
      const runtime = manager.states().find((item) => item.siteId === args.site_id)
      if (!runtime?.dialog) throw new Error('当前没有等待应答的对话框')
      await manager.answerDialog(manager.agentTarget(args.site_id), runtime.dialog.id, args.accept, args.text)
      return report('已应答对话框。')
    }),
  tool('click', 'full', '在页面坐标上点击；坐标以远端视口为基准，可先截图确认位置。', object({
    site_id: SITE, tab_id: TAB, x: X, y: Y, button: { type: 'string', enum: ['left', 'middle', 'right'] },
    click_count: { type: 'integer', minimum: 1, maximum: 3, description: '2 为双击' }
  }, ['site_id', 'x', 'y']), tab.extend({ ...point, button: z.enum(['left', 'middle', 'right']).default('left'), click_count: z.number().int().min(1).max(3).default(1) }).strict(),
  async (manager, args) => {
    const { site_id: siteId, tab_id: tabId, x, y, button, click_count: clickCount } = args
    await manager.agentInput(siteId, tabId, { type: 'move', x, y })
    await manager.agentInput(siteId, tabId, { type: 'down', x, y, button, clickCount })
    await manager.agentInput(siteId, tabId, { type: 'up', x, y, button, clickCount })
    return report('已点击。请用 read_page 或 capture_screenshot 确认结果。')
  }),
  tool('type_text', 'full', '向当前焦点元素输入文本，支持中文；不会自动提交表单。',
    object({ site_id: SITE, tab_id: TAB, text: { type: 'string', maxLength: 100000 } }, ['site_id', 'text']),
    tab.extend({ text: z.string().max(100000) }).strict(), async (manager, args) => {
      await manager.agentInput(args.site_id, args.tab_id, { type: 'text', text: args.text })
      return report('已输入文本。')
    }),
  tool('press_key', 'full', '按下并松开一个按键，例如 Enter、Tab、Backspace、ArrowDown。',
    object({ site_id: SITE, tab_id: TAB, key: { type: 'string', maxLength: 40 } }, ['site_id', 'key']),
    tab.extend({ key: z.string().min(1).max(40) }).strict(), async (manager, args) => {
      await manager.agentInput(args.site_id, args.tab_id, { type: 'keyDown', key: args.key })
      await manager.agentInput(args.site_id, args.tab_id, { type: 'keyUp', key: args.key })
      return report(`已按下 ${args.key}。`)
    }),
  tool('scroll', 'full', '在指定坐标滚动页面，正的 delta_y 表示向下。', object({
    site_id: SITE, tab_id: TAB, x: X, y: Y,
    delta_x: { type: 'number', minimum: -10000, maximum: 10000 }, delta_y: { type: 'number', minimum: -10000, maximum: 10000 }
  }, ['site_id', 'delta_y']), tab.extend({
    x: point.x.optional(), y: point.y.optional(),
    delta_x: z.number().finite().min(-10000).max(10000).default(0), delta_y: z.number().finite().min(-10000).max(10000)
  }).strict(), async (manager, args) => {
    const geometry = await manager.geometry(args.site_id, args.tab_id)
    await manager.agentInput(args.site_id, args.tab_id, { type: 'wheel', x: args.x ?? geometry.width / 2, y: args.y ?? geometry.height / 2, deltaX: args.delta_x, deltaY: args.delta_y })
    return report('已滚动页面。')
  }),
  tool('read_cookies', 'full', '读取该配置的 Cookie 明文，含 domain、path 及安全属性。', object({ site_id: SITE }, ['site_id']), site, async (manager, args) => {
    const view = await manager.readCookies(args.site_id)
    return report({ pending: view.pending, updated_at: view.updatedAt, cookies: view.cookies })
  }),
  tool('apply_cookies', 'full', '写入或删除 Cookie；运行中直接生效，停止状态会存为待应用修改。', object({
    site_id: SITE,
    upsert: { type: 'array', description: 'Cookie 对象数组，至少含 name、value、domain、path', items: { type: 'object' } },
    remove: { type: 'array', description: '要删除的 Cookie，按 name、domain、path、分区匹配', items: { type: 'object' } }
  }, ['site_id']), site.extend({ upsert: cookieChangesSchema.shape.upsert.default([]), remove: cookieChangesSchema.shape.remove.default([]) }).strict(),
  async (manager, args) => {
    if (!args.upsert.length && !args.remove.length) throw new Error('请至少提供一个要写入或删除的 Cookie')
    await manager.applyCookies(args.site_id, { upsert: args.upsert, remove: args.remove })
    return report('已应用 Cookie 修改。')
  }),
  tool('restore_cookies', 'full', '把最近一次加密快照中未过期的 Cookie 恢复到浏览器。', object({ site_id: SITE }, ['site_id']), site, async (manager, args) => {
    await manager.restoreCookies(args.site_id)
    return report('已恢复快照中的 Cookie。')
  }),
  tool('save_site', 'full', '新增或修改网站配置，保存不刷新页面，重启后生效。省略 injections / browserOptions / captureEnabled 保留原值；抓包接入需先在桌面启动代理；browserOptions 对象完整替换，{} 恢复桌面默认。预设仅模拟 Chrome 设备；UA 留空继承全局默认 UA，自定义 UA 不推测 Client Hints。proxy_credentials 只写：省略保留、null 清除、对象替换，仅 HTTP/HTTPS。注入是可信本机代码，需用户授权。', object({
    site_id: { ...SITE, description: '省略则新增配置' }, name: { type: 'string', maxLength: 80 }, url: { type: 'string', description: 'HTTP / HTTPS 网址' },
    injections: z.toJSONSchema(siteDraftSchema.shape.injections, { io: 'input' }),
    browserOptions: z.toJSONSchema(browserOptionsSchema, { io: 'input' }),
    captureEnabled: { type: 'boolean', description: '接入抓包代理；重启网站生效，省略保留原值' },
    proxy_credentials: { ...z.toJSONSchema(proxyCredentialsSchema.nullable(), { io: 'input' }), writeOnly: true }
  }, ['name', 'url']), z.object({ site_id: idSchema.optional(), ...siteDraftSchema.shape, injections: siteDraftSchema.shape.injections.removeDefault().optional(), browserOptions: browserOptionsSchema.optional(), captureEnabled: z.boolean().optional(), proxy_credentials: proxyCredentialsSchema.nullable().optional() }).strict(), async (manager, args) => {
    const id = await manager.saveSite(args.site_id, { name: args.name, url: args.url, injections: args.injections, browserOptions: args.browserOptions, captureEnabled: args.captureEnabled }, args.proxy_credentials)
    return report({ site_id: id, name: args.name, url: args.url })
  }),
  tool('clear_site', 'full', '清除配置的登录数据，或连配置一起删除；不可撤销，会先停止浏览器。', object({
    site_id: SITE, delete_config: { type: 'boolean', description: 'true 时连配置一起删除，默认只清登录数据' }
  }, ['site_id']), site.extend({ delete_config: z.boolean().default(false) }).strict(), async (manager, args) => {
    await manager.clearSite(args.site_id, args.delete_config)
    return report(args.delete_config ? '已删除配置及其登录数据。' : '已清除该配置的登录数据。')
  }),
  tool('save_settings', 'full', '修改全局配置，只需给出要改的项；默认 UA 在网站下次启动时生效，npm Registry 在下次安装沙箱依赖时生效，其他设置即时生效。', object({
    max_running: { type: 'integer', minimum: 1 }, grid_fps: { type: 'integer', minimum: 1, maximum: 5 },
    focus_fps: { type: 'integer', minimum: 5, maximum: 30 }, quality: { type: 'integer', minimum: 40, maximum: 90 },
    navigation_timeout: { type: 'integer', minimum: 10, maximum: 120, description: '秒' },
    default_user_agent: { type: 'string', maxLength: 4096, description: '全局默认 UA；网站 UA / 设备预设优先；空字符串恢复浏览器默认，不得包含换行或控制字符，最多 4096 字符' },
    sandbox_registry: { type: 'string', maxLength: 2048, description: '安装沙箱第三方包使用的 HTTP / HTTPS npm registry，不含账号密码' }
  }), z.object({
    max_running: z.number().int().optional(), grid_fps: z.number().int().optional(), focus_fps: z.number().int().optional(),
    quality: z.number().int().optional(), navigation_timeout: z.number().int().optional(), default_user_agent: userAgentSchema.optional(), sandbox_registry: npmRegistrySchema.optional()
  }).strict(), async (manager, args) => {
    const current = manager.store.get().settings
    const settings = settingsSchema.parse({
      maxRunning: args.max_running ?? current.maxRunning, gridFps: args.grid_fps ?? current.gridFps,
      focusFps: args.focus_fps ?? current.focusFps, quality: args.quality ?? current.quality,
      navigationTimeout: args.navigation_timeout ?? current.navigationTimeout,
      defaultUserAgent: args.default_user_agent ?? current.defaultUserAgent,
      sandboxRegistry: args.sandbox_registry ?? current.sandboxRegistry
    })
    await manager.saveSettings(settings)
    return report(settings)
  })
]
