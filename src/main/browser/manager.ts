import type { Browser, Dialog, Page } from 'puppeteer-core'
import type { PageGeometry, ProxyCredentials } from '../../shared/browser-options'
import type { CaptureLease } from '../../shared/capture'
import type { Cookie, CookieChanges, CookieView, Frame, RemoteInput, Runtime, Settings, Site, SiteDraft, Target } from '../../shared/model'
import type { CaptureService } from '../capture/service'
import type { InjectionService } from '../scripts/injections'
import type { ProxyVault } from '../storage/proxy-vault'
import type { ConfigStore, CookieVault, VaultData } from '../storage/store'
import type { TaskService } from '../tasks/service'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { z } from 'zod'
import { browserOptionsFingerprint, browserOptionsSchema, proxyCredentialsSchema } from '../../shared/browser-options'
import { cookieKey, mergeCookies, validateCookies } from '../../shared/cookies'
import { cookieSchema, MAX_TABS, siteDraftSchema, urlSchema } from '../../shared/model'
import { SerialQueue } from '../storage/store'
import { PageInput } from './input'
import { PageInterception } from './interception'
import { applyPageOptions, captureArguments, captureOptions, connectionOptions, jpegSize, pageGeometry, pageScreenshot, proxyArguments, resolveOptions, withPageOperation } from './options'
import { PageStream } from './stream'

type ManagedPage = { page: Page; id: string; targetId?: string; interception?: PageInterception; input: PageInput; dialog?: Dialog; dialogId?: string }
type Instance = { runtime: Runtime; startupSite?: Site; captureLease?: CaptureLease; optionsFingerprint?: string; proxyCredentials?: ProxyCredentials; browser?: Browser; pages: Map<string, ManagedPage>; queue: SerialQueue; stream?: PageStream; streamEpoch: number; capturing: boolean }
const manifestSchema = z.object({ arch: z.string(), buildId: z.string(), executable: z.string() })
export async function resolveBrowser(root: string): Promise<{ executable: string; version: string }> {
  try {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
    if (manifest.arch !== process.arch) throw new Error('浏览器架构与本机不符')
    const executable = path.resolve(root, manifest.executable)
    if (!executable.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('浏览器路径无效')
    await access(executable)
    return { executable, version: manifest.buildId }
  } catch { throw new Error('附带浏览器缺失或架构不匹配。开发环境请运行 npm run browser:prepare，安装包请重新安装。') }
}
export async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('操作超时')), milliseconds) })])
  } finally { if (timer) clearTimeout(timer) }
}

export class BrowserManager {
  injections?: InjectionService
  tasks?: TaskService
  captureService?: CaptureService
  private instances = new Map<string, Instance>()
  private focus: string | null = null
  private visible = true
  private windowVisible = true
  private sequence = 0
  private closing = false
  private configurationQueue = new SerialQueue()
  private timer: NodeJS.Timeout
  constructor(readonly store: ConfigStore, readonly vault: CookieVault, private browserRoot: string,
    private changed: () => void, private frame: (frame: Frame) => void, private proxyVault?: ProxyVault) {
    this.timer = setInterval(() => {
      for (const instance of this.instances.values()) {
        if (instance.runtime.status !== 'running' || instance.capturing) continue
        instance.capturing = true
        void instance.queue.run(() => this.capture(instance)).catch(() => {
          instance.runtime.warning = '自动保存 Cookie 失败，请检查钥匙串授权或手动重试。'; this.changed()
        }).finally(() => { instance.capturing = false })
      }
    }, 30000)
  }
  states(): Runtime[] {
    return [...this.instances.values()].map((entry) => {
      const runtime = structuredClone(entry.runtime)
      const session = this.injections?.session(runtime.siteId)
      if (session) runtime.injections = session.states()
      if (runtime.status === 'running') {
        const site = this.store.site(runtime.siteId)
        runtime.captureActive = Boolean(entry.captureLease && this.captureService?.isLeaseActive(entry.captureLease))
        runtime.captureError = Boolean(entry.captureLease && !runtime.captureActive)
        runtime.capturePending = site.captureEnabled !== Boolean(entry.startupSite?.captureEnabled) || Boolean(entry.captureLease && (runtime.captureError || this.captureService?.state().pending))
        runtime.injectionsPending = runtime.injectionFingerprint !== this.injections?.fingerprint(site)
        runtime.browserOptionsPending = entry.optionsFingerprint !== browserOptionsFingerprint(site.browserOptions, site.proxyCredentialId, this.store.get().settings.defaultUserAgent)
      }
      return runtime
    })
  }
  runningCount(): number { return this.states().filter((state) => ['starting', 'running', 'stopping'].includes(state.status)).length }
  async saveSite(id: string | undefined, raw: SiteDraft, credentials?: ProxyCredentials | null): Promise<string> {
    const operation = () => this.configurationQueue.run(async () => {
      const previous = id ? this.store.site(id) : undefined
      const draft = siteDraftSchema.parse({ ...raw, injections: raw.injections ?? previous?.injections ?? [], browserOptions: raw.browserOptions ?? previous?.browserOptions ?? {}, captureEnabled: raw.captureEnabled ?? previous?.captureEnabled ?? false })
      this.injections?.validate(draft.injections, draft.url)
      const now = new Date().toISOString()
      const siteId = id || randomUUID()
      let proxyCredentialId = previous?.proxyCredentialId
      if (!draft.browserOptions.proxy || credentials === null) proxyCredentialId = undefined
      if (credentials || proxyCredentialId) {
        if (!draft.browserOptions.proxy || new URL(draft.browserOptions.proxy.server).protocol === 'socks5:') throw new Error('代理账号密码仅支持 HTTP/HTTPS 代理')
      }
      let created: string | undefined
      if (credentials) {
        if (!this.proxyVault) throw new Error('代理凭据存储不可用')
        created = await this.proxyVault.create(proxyCredentialsSchema.parse(credentials)); proxyCredentialId = created
      }
      try {
        await this.store.update((config) => {
          if (id) {
            const site = config.sites.find((item) => item.id === id)
            if (!site) throw new Error('页面配置不存在')
            Object.assign(site, draft, { updatedAt: now, proxyCredentialId })
          } else {
            config.sites.push({ ...draft, id: siteId, order: config.sites.length, createdAt: now, updatedAt: now, cookieCount: 0, pendingCookies: false, proxyCredentialId })
          }
        })
      } catch (error) {
        if (created) await this.proxyVault?.remove(created).catch(() => undefined)
        throw error
      }
      await this.collectProxyCredentials()
      this.changed()
      return siteId
    })
    return this.injections ? this.injections.mutate(operation) : operation()
  }
  private async collectProxyCredentials() {
    const references = new Set(this.store.get().sites.flatMap((site) => site.proxyCredentialId ? [site.proxyCredentialId] : []))
    for (const entry of this.instances.values()) {
      if (entry.startupSite?.proxyCredentialId && ['starting', 'running', 'stopping'].includes(entry.runtime.status)) references.add(entry.startupSite.proxyCredentialId)
    }
    await this.proxyVault?.collect(references).catch(() => undefined)
  }
  async saveSettings(settings: Settings): Promise<void> {
    await this.store.update((config) => { config.settings = settings })
    await Promise.all([...this.instances.values()].map(async (instance) => {
      if (instance.startupSite?.browserOptions.navigationTimeout !== undefined) return
      for (const tab of instance.pages.values()) tab.page.setDefaultNavigationTimeout(settings.navigationTimeout * 1000)
      await this.injections?.session(instance.runtime.siteId)?.setNavigationTimeout(settings.navigationTimeout).catch(() => { instance.runtime.warning = '注入导航超时更新失败，请重启网站' })
    }))
    await this.refreshStreams()
  }
  private entry(id: string): Instance {
    this.store.site(id)
    let instance = this.instances.get(id)
    if (!instance) {
      instance = { runtime: { siteId: id, generation: randomUUID(), status: 'stopped', tabs: [] }, pages: new Map(), queue: new SerialQueue(), streamEpoch: 0, capturing: false }
      this.instances.set(id, instance)
    }
    return instance
  }
  private requireRunning(instance: Instance): Browser {
    if (instance.runtime.status !== 'running' || !instance.browser) throw new Error('请先启动该网站')
    return instance.browser
  }
  private target(target: Target, active = false): { instance: Instance; tab: ManagedPage } {
    const instance = this.entry(target.siteId)
    this.requireRunning(instance)
    const tab = instance.pages.get(target.tabId)
    if (instance.runtime.generation !== target.generation || !tab || tab.page.isClosed()) throw new Error('页面已关闭或重新启动，请重试')
    if (active && instance.runtime.activeTabId !== target.tabId) throw new Error('只能操作当前标签')
    return { instance, tab }
  }
  async start(id: string): Promise<void> {
    const instance = this.entry(id)
    await instance.queue.run(async () => {
      if (this.closing) throw new Error('应用正在退出')
      if (['starting', 'running', 'stopping'].includes(instance.runtime.status)) return
      if (this.runningCount() >= this.store.get().settings.maxRunning) throw new Error('已达到同时运行上限，请先停止一个网站')
      instance.startupSite = this.store.site(id)
      const defaultUserAgent = this.store.get().settings.defaultUserAgent
      instance.optionsFingerprint = browserOptionsFingerprint(instance.startupSite.browserOptions, instance.startupSite.proxyCredentialId, defaultUserAgent)
      instance.proxyCredentials = undefined
      instance.runtime = { siteId: id, generation: randomUUID(), status: 'starting', tabs: [], viewport: instance.startupSite.browserOptions.viewport }
      this.changed()
      try {
        await this.injections?.stop(id)
        const executable = await resolveBrowser(this.browserRoot)
        const startupSite = instance.startupSite
        startupSite.browserOptions = resolveOptions(startupSite.browserOptions, executable.version, defaultUserAgent)
        let options = startupSite.browserOptions
        if (startupSite.captureEnabled && this.captureService?.state().status !== 'running') throw new Error('抓包代理未运行，请先在“抓包调试”中启动代理')
        if (startupSite.proxyCredentialId) {
          if (!this.proxyVault) throw new Error('代理凭据存储不可用')
          instance.proxyCredentials = await this.proxyVault.read(startupSite.proxyCredentialId)
        }
        if (startupSite.captureEnabled) {
          instance.captureLease = await this.captureService!.acquire(startupSite, instance.runtime.generation, instance.proxyCredentials)
          options = captureOptions(options, instance.captureLease)
          instance.proxyCredentials = undefined
        }
        const profile = this.store.profile(id)
        await mkdir(profile, { recursive: true, mode: 0o700 })
        const browser = await puppeteer.launch({
          executablePath: executable.executable, browser: 'chrome', userDataDir: profile,
          headless: options.headless, acceptInsecureCerts: options.acceptInsecureCerts, slowMo: options.slowMo,
          pipe: false, debuggingPort: 0, timeout: 60000, protocolTimeout: 15000,
          defaultViewport: null,
          // 指定 address 后 Puppeteer 不再自动补 port，必须显式使用随机端口。
          args: ['--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', ...(options.acceptInsecureCerts ? ['--ignore-certificate-errors'] : []), ...proxyArguments(options), ...captureArguments(instance.captureLease)],
          handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false
        })
        instance.browser = browser
        browser.on('disconnected', () => {
          if (instance.browser !== browser || instance.runtime.status === 'stopping') return
          instance.browser = undefined; instance.proxyCredentials = undefined
          instance.runtime.status = 'error'; instance.runtime.error = '浏览器意外退出。登录目录已保留，可以重新启动。'
          void this.stopStream(instance)
          void this.injections?.stop(id)
          void this.releaseCapture(instance).catch(() => { instance.runtime.warning = '抓包出口清理失败，请停止抓包代理'; this.changed() })
          for (const tab of instance.pages.values()) { void tab.interception?.stop(); void tab.input.dispose() }
          instance.pages.clear(); instance.runtime.tabs = []; instance.runtime.dialog = undefined
          this.changed()
        })
        const session = await browser.target().createCDPSession()
        try { await session.send('Browser.setDownloadBehavior', { behavior: 'deny' }) } finally { await session.detach() }
        await browser.defaultBrowserContext().clearPermissionOverrides()
        if (options.geolocation) await browser.defaultBrowserContext().overridePermissions(new URL(startupSite.url).origin, ['geolocation'])
        const saved = await this.vault.read(id)
        if (saved.pending) {
          await this.applyToBrowser(browser, saved.pending)
          await this.capture(instance, true)
        }
        if (this.injections) {
          await this.injections.mutate(async () => {
            const injection = await this.injections!.begin(startupSite, browser.wsEndpoint(), (text) => { instance.runtime.warning = text; this.changed() }, connectionOptions(options, this.store.get().settings.navigationTimeout))
            instance.runtime.injectionFingerprint = injection?.fingerprint || this.injections!.fingerprint(startupSite)
          })
        }
        const initial = (await browser.pages())[0] || await browser.newPage()
        await this.addPage(instance, initial)
        browser.on('targetcreated', (target) => {
          if (target.type() !== 'page') return
          void target.page().then((page) => {
            if (page) {
              return instance.queue.run(async () => {
                if (instance.browser !== browser || instance.runtime.status !== 'running') return
                await this.addPage(instance, page, true)
              })
            }
          }).catch(() => { instance.runtime.warning = '新标签创建失败'; this.changed() })
        })
        instance.runtime.status = 'running'
        await this.restream(instance)
        this.changed()
        void this.navigate({ siteId: id, generation: instance.runtime.generation, tabId: instance.runtime.activeTabId! }, 'navigate', startupSite.url).catch(() => undefined)
      } catch (error) {
        await this.stopStream(instance)
        await Promise.all([...instance.pages.values()].map(async (tab) => { await tab.interception?.stop(); await tab.input.dispose() }))
        await this.injections?.stop(id)
        const browser = instance.browser
        instance.browser = undefined
        if (browser) await this.closeBrowser(browser)
        await this.releaseCapture(instance)
        instance.pages.clear(); instance.runtime.tabs = []
        const rawReason = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300)
        const reason = instance.startupSite?.proxyCredentialId && !rawReason.startsWith('代理凭据') && !rawReason.startsWith('抓包') ? '浏览器初始化失败，请检查代理连接、认证及浏览器配置' : rawReason
        instance.proxyCredentials = undefined
        console.error('[octo] 启动失败', reason)
        instance.runtime.status = 'error'
        instance.runtime.error = `启动失败：${reason}（原登录数据已保留）`
        this.changed()
        throw new Error(instance.runtime.error)
      }
    })
  }
  private async addPage(instance: Instance, page: Page, popup = false): Promise<void> {
    if ([...instance.pages.values()].some((tab) => tab.page === page) || page.isClosed()) return
    if (instance.pages.size >= MAX_TABS) {
      await page.close(); instance.runtime.warning = `每个配置最多打开 ${MAX_TABS} 个标签`; this.changed(); return
    }
    const options = instance.startupSite?.browserOptions ?? browserOptionsSchema.parse({})
    const tab: ManagedPage = { id: randomUUID(), page, input: new PageInput(page, options.viewport.isMobile && options.viewport.hasTouch) }
    instance.pages.set(tab.id, tab)
    instance.runtime.tabs.push({ id: tab.id, title: '新标签', url: page.url(), loading: false })
    try {
      const popupSession = popup ? await page.createCDPSession() : undefined
      if (popupSession) page.once('close', () => { void popupSession.detach().catch(() => undefined) })
      await applyPageOptions(page, options, this.store.get().settings.navigationTimeout, popupSession)
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return
        const state = instance.runtime.tabs.find((item) => item.id === tab.id)
        if (!state) return
        state.url = page.url(); state.loading = true; state.error = undefined
        this.changed()
      })
      const loaded = () => {
        const state = instance.runtime.tabs.find((item) => item.id === tab.id)
        if (!state) return
        state.loading = false; state.url = page.url()
        void page.title().then((title) => { state.title = title || '新标签'; this.changed() }).catch(() => undefined)
        void withPageOperation(page, () => pageGeometry(page)).then((geometry) => { state.geometry = geometry; this.changed() }).catch(() => undefined)
        this.changed()
      }
      page.on('domcontentloaded', loaded)
      page.on('load', loaded)
      page.on('dialog', (dialog) => {
        if (page.isClosed() || instance.runtime.status !== 'running') { void dialog.dismiss().catch(() => undefined); return }
        tab.dialog = dialog; tab.dialogId = randomUUID()
        // 对话框会阻塞页面进程，发往该页的 CDP 调用要等到关闭才返回，
        // 所以先把对话框推给界面，再异步补上标签切换。
        instance.runtime.activeTabId = tab.id
        instance.runtime.dialog = this.dialogView(tab)
        this.changed()
        if (instance.runtime.tabs.length > 1) {
          void instance.queue.run(async () => {
            if (page.isClosed() || instance.runtime.status !== 'running' || !tab.dialog) return
            await this.activatePage(instance, tab.id)
          }).catch(() => undefined)
        }
      })
      page.on('error', () => {
        const state = instance.runtime.tabs.find((item) => item.id === tab.id)
        if (state) { state.error = '页面进程异常，请刷新或关闭后重新打开'; state.loading = false; this.changed() }
      })
      page.on('close', () => {
        void instance.queue.run(async () => {
          await tab.interception?.stop()
          await tab.input.dispose()
          if (tab.targetId) await this.injections?.session(instance.runtime.siteId)?.disposeTab(tab.id, tab.targetId)
          instance.pages.delete(tab.id)
          instance.runtime.tabs = instance.runtime.tabs.filter((item) => item.id !== tab.id)
          if (instance.runtime.status !== 'running') return
          if (instance.runtime.activeTabId === tab.id) {
            instance.runtime.dialog = undefined
            const next = [...instance.pages.keys()].at(-1)
            if (next) await this.activatePage(instance, next)
            else if (instance.browser?.connected) await this.addPage(instance, await instance.browser.newPage())
          }
          this.changed()
        }).catch(() => undefined)
      })
      const preventUploads = async () => {
        while (!page.isClosed()) {
          const chooser = await page.waitForFileChooser({ timeout: 0 })
          await chooser.cancel()
          instance.runtime.warning = '首期暂不支持文件上传'; this.changed()
        }
      }
      void preventUploads().catch(() => undefined)
      const session = await page.createCDPSession()
      try { tab.targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId } finally { await session.detach() }
      const injection = this.injections?.session(instance.runtime.siteId)
      await injection?.install(tab.id, tab.targetId, page.url())
      tab.interception = new PageInterception(page, tab.id, injection, (text) => { instance.runtime.warning = text; this.changed() }, options.proxy && instance.proxyCredentials ? { server: options.proxy.server, credentials: instance.proxyCredentials } : undefined)
      await tab.interception.start()
      await this.activatePage(instance, tab.id)
      loaded()
    } catch (error) {
      await tab.interception?.stop()
      await tab.input.dispose()
      if (tab.targetId) await this.injections?.session(instance.runtime.siteId)?.disposeTab(tab.id, tab.targetId)
      instance.pages.delete(tab.id)
      instance.runtime.tabs = instance.runtime.tabs.filter((item) => item.id !== tab.id)
      await page.close().catch(() => undefined)
      throw error
    }
  }
  // 对话框 id 必须稳定，否则界面已打开的弹框会因 id 变化而无法应答。
  private dialogView(tab: ManagedPage): Runtime['dialog'] {
    if (!tab.dialog || !tab.dialogId) return undefined
    return { id: tab.dialogId, type: tab.dialog.type(), message: tab.dialog.message().slice(0, 10000), defaultValue: tab.dialog.defaultValue().slice(0, 10000) }
  }
  private async activatePage(instance: Instance, id: string): Promise<void> {
    const old = instance.pages.get(instance.runtime.activeTabId || '')
    if (old && old.id !== id) await old.input.deactivate()
    instance.runtime.activeTabId = id
    instance.runtime.dialog = undefined
    const tab = instance.pages.get(id)
    if (tab) {
      tab.input.activate(); await tab.page.bringToFront()
      instance.runtime.dialog = this.dialogView(tab)
    }
    if (instance.runtime.status === 'running') await this.restream(instance)
    this.changed()
  }
  private async stopStream(instance: Instance): Promise<void> {
    instance.streamEpoch++
    const stream = instance.stream
    instance.stream = undefined
    await stream?.stop()
  }
  private async restream(instance: Instance): Promise<void> {
    await this.stopStream(instance)
    if (!this.visible || !this.windowVisible || instance.runtime.status !== 'running') { instance.runtime.streamMode = 'paused'; return }
    const tab = instance.pages.get(instance.runtime.activeTabId || '')
    if (!tab) return
    const epoch = instance.streamEpoch
    const stream = new PageStream(tab.page, { siteId: instance.runtime.siteId, generation: instance.runtime.generation, tabId: tab.id },
      () => { const settings = this.store.get().settings; return { fps: this.focus === instance.runtime.siteId ? settings.focusFps : settings.gridFps, quality: settings.quality } },
      () => ++this.sequence, this.frame,
      (mode) => { if (epoch === instance.streamEpoch) { instance.runtime.streamMode = mode; this.changed() } })
    instance.stream = stream
    void stream.start().catch(() => undefined)
  }
  acknowledge(frame: Omit<Frame, 'data'>): void { this.instances.get(frame.siteId)?.stream?.mailbox.acknowledge(frame) }
  async setView(focus: string | null, visible: boolean): Promise<void> {
    const previous = this.focus
    const visibilityChanged = this.visible !== visible
    this.focus = focus; this.visible = visible
    if (previous && (previous !== focus || !visible)) {
      const instance = this.instances.get(previous)
      await instance?.pages.get(instance.runtime.activeTabId || '')?.input.run({ type: 'release' })
    }
    if (visibilityChanged) await this.refreshStreams()
  }
  async setWindowVisible(visible: boolean): Promise<void> {
    if (this.windowVisible === visible) return
    this.windowVisible = visible
    if (!visible) await Promise.all([...this.instances.values()].flatMap((entry) => [...entry.pages.values()].map((tab) => tab.input.run({ type: 'release' }))))
    await this.refreshStreams()
  }
  async refreshStreams(): Promise<void> {
    await Promise.all([...this.instances.values()].map((entry) => entry.queue.run(() => this.restream(entry))))
    this.changed()
  }
  async newTab(id: string): Promise<void> {
    const instance = this.entry(id)
    await instance.queue.run(async () => {
      const browser = this.requireRunning(instance)
      if (instance.pages.size >= MAX_TABS) throw new Error(`最多打开 ${MAX_TABS} 个标签`)
      await this.addPage(instance, await browser.newPage())
    })
  }
  async tabAction(target: Target, action: 'activate' | 'close'): Promise<void> {
    const { instance } = this.target(target)
    await instance.queue.run(async () => {
      const { tab } = this.target(target)
      if (action === 'activate') await this.activatePage(instance, tab.id)
      else await tab.page.close()
    })
  }
  async navigate(target: Target, action: 'navigate' | 'back' | 'forward' | 'reload', url?: string): Promise<void> {
    const { instance, tab } = this.target(target, true)
    const state = instance.runtime.tabs.find((item) => item.id === tab.id)!
    state.loading = true; state.error = undefined; this.changed()
    tab.page.setDefaultNavigationTimeout((instance.startupSite?.browserOptions.navigationTimeout ?? this.store.get().settings.navigationTimeout) * 1000)
    try {
      const options = { waitUntil: 'domcontentloaded' as const }
      if (action === 'navigate') await tab.page.goto(urlSchema.parse(url), options)
      else if (action === 'back') await tab.page.goBack(options)
      else if (action === 'forward') await tab.page.goForward(options)
      else await tab.page.reload(options)
    } catch { state.error = '导航失败或超时，请检查网络、网址后重试' } finally { state.loading = false; this.changed() }
  }
  async input(target: Target, input: RemoteInput): Promise<void> {
    if (input.type === 'release') {
      const instance = this.instances.get(target.siteId)
      if (instance?.runtime.generation === target.generation) await instance.pages.get(target.tabId)?.input.run(input)
      return
    }
    const { tab } = this.target(target, true)
    if (!this.visible || !this.windowVisible || this.focus !== target.siteId) throw new Error('请在放大视图中操作网页')
    await tab.input.run(input)
  }
  async answerDialog(target: Target, id: string, accept: boolean, text?: string): Promise<void> {
    const { instance, tab } = this.target(target, true)
    if (instance.runtime.dialog?.id !== id || !tab.dialog) throw new Error('对话框已失效')
    const dialog = tab.dialog
    // 必须等对话框真正关闭再解除界面封锁，否则期间发去的输入会被页面丢弃。
    if (accept) await dialog.accept(text); else await dialog.dismiss()
    tab.dialog = undefined; tab.dialogId = undefined; instance.runtime.dialog = undefined; this.changed()
  }
  // 本机代理（MCP）没有界面焦点，按站点解析当前标签，必要时先切换过去再操作。
  private agentTab(siteId: string, tabId?: string): { instance: Instance; tab: ManagedPage } {
    const instance = this.entry(siteId)
    this.requireRunning(instance)
    const id = tabId || instance.runtime.activeTabId
    const tab = id ? instance.pages.get(id) : undefined
    if (!tab || tab.page.isClosed()) throw new Error('标签不存在或已关闭')
    return { instance, tab }
  }
  agentTarget(siteId: string, tabId?: string): Target {
    const { instance, tab } = this.agentTab(siteId, tabId)
    return { siteId, tabId: tab.id, generation: instance.runtime.generation }
  }
  async agentFocus(siteId: string, tabId?: string): Promise<Target> {
    const target = this.agentTarget(siteId, tabId)
    const { instance } = this.agentTab(siteId, target.tabId)
    if (instance.runtime.activeTabId !== target.tabId) await this.tabAction(target, 'activate')
    return target
  }
  // 只交给本机脚本 Worker，不进入 IPC/MCP 返回值。执行不占用站点队列，Cookie 自动保存仍可继续。
  async scriptSession(siteId: string, tabId?: string) {
    const target = await this.agentFocus(siteId, tabId)
    const { instance, tab } = this.target(target)
    const browser = this.requireRunning(instance)
    const session = await tab.page.createCDPSession()
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo')
      const site = this.store.site(siteId)
      return { endpoint: browser.wsEndpoint(), targetId: targetInfo.targetId, connectionOptions: connectionOptions(instance.startupSite!.browserOptions, this.store.get().settings.navigationTimeout), site: { id: site.id, name: site.name, url: site.url, tabId: tab.id, currentUrl: tab.page.url() } }
    } finally { await session.detach() }
  }
  async readPage(siteId: string, tabId: string | undefined, html: boolean, limit: number): Promise<{ tabId: string; title: string; url: string; content: string; truncated: boolean }> {
    const instance = this.entry(siteId)
    return instance.queue.run(async () => {
      const { tab } = this.agentTab(siteId, tabId)
      const title = await tab.page.title().catch(() => '')
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- 需要渲染后的可见文本，而非包含脚本/隐藏节点的 textContent。
      const full = html ? await tab.page.content() : await tab.page.evaluate(() => document.body?.innerText || '')
      return { tabId: tab.id, title, url: tab.page.url(), content: full.slice(0, limit), truncated: full.length > limit }
    })
  }
  async screenshot(siteId: string, tabId?: string): Promise<{ tabId: string; data: string; geometry: PageGeometry; image: { width: number; height: number } }> {
    const instance = this.entry(siteId)
    return instance.queue.run(async () => {
      const { tab } = this.agentTab(siteId, tabId)
      const { geometry, data } = await pageScreenshot(tab.page, this.store.get().settings.quality)
      return { tabId: tab.id, data, geometry, image: jpegSize(data) }
    })
  }
  async geometry(siteId: string, tabId?: string): Promise<PageGeometry> {
    const { instance, tab } = this.agentTab(siteId, tabId)
    const geometry = await withPageOperation(tab.page, () => pageGeometry(tab.page))
    const state = instance.runtime.tabs.find((item) => item.id === tab.id)
    if (state) state.geometry = geometry
    return geometry
  }
  async agentInput(siteId: string, tabId: string | undefined, input: RemoteInput): Promise<void> {
    const target = await this.agentFocus(siteId, tabId)
    const { tab } = this.agentTab(siteId, target.tabId)
    await tab.input.run(input)
  }
  private async browserCookies(browser: Browser): Promise<Cookie[]> {
    return (await browser.defaultBrowserContext().cookies()).map((cookie) => cookieSchema.parse({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure,
      sameSite: cookie.sameSite === 'Default' ? undefined : cookie.sameSite, priority: cookie.priority,
      sourceScheme: cookie.sourceScheme, partitionKey: cookie.partitionKey
    })).sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)))
  }
  private async metadata(id: string, data: VaultData): Promise<void> {
    const site = this.store.site(id)
    if (site.cookieUpdatedAt === data.updatedAt && site.cookieCount === data.snapshot.length && site.pendingCookies === Boolean(data.pending)) return
    await this.store.update((config) => {
      const site = config.sites.find((item) => item.id === id)!
      site.cookieUpdatedAt = data.updatedAt; site.cookieCount = data.snapshot.length; site.pendingCookies = Boolean(data.pending)
    })
    this.changed()
  }
  private async capture(instance: Instance, clearPending = false): Promise<void> {
    if (!instance.browser?.connected) return
    const data = await this.vault.capture(instance.runtime.siteId, await this.browserCookies(instance.browser), clearPending)
    await this.metadata(instance.runtime.siteId, data)
  }
  async captureCookies(id: string): Promise<void> {
    const instance = this.entry(id)
    await instance.queue.run(async () => { this.requireRunning(instance); await this.capture(instance) })
  }
  async readCookies(id: string): Promise<CookieView> {
    const instance = this.entry(id)
    return instance.queue.run(async () => {
      const data = await this.vault.read(id)
      const base = instance.runtime.status === 'running' && instance.browser ? await this.browserCookies(instance.browser) : data.snapshot
      return { cookies: data.pending ? mergeCookies(base, data.pending) : base, pending: Boolean(data.pending), updatedAt: data.updatedAt }
    })
  }
  private async applyToBrowser(browser: Browser, changes: CookieChanges): Promise<void> {
    const context = browser.defaultBrowserContext()
    const existing = await context.cookies()
    for (const cookie of changes.remove) {
      const exact = existing.filter((item) => cookieKey({ ...item, sameSite: item.sameSite === 'Default' ? undefined : item.sameSite }) === cookieKey(cookie))
      if (exact.length) await context.deleteCookie(...exact)
    }
    if (changes.upsert.length) await context.setCookie(...changes.upsert.map((cookie) => ({ ...cookie, expires: cookie.expires === -1 ? undefined : cookie.expires })))
  }
  async applyCookies(id: string, changes: CookieChanges): Promise<void> {
    validateCookies(changes.upsert)
    const instance = this.entry(id)
    await instance.queue.run(async () => {
      if (instance.runtime.status === 'running' && instance.browser) {
        try { await this.applyToBrowser(instance.browser, changes); await this.capture(instance, true) } catch { throw new Error('Cookie 应用或保存失败，部分条目可能已生效。请重新读取并检查安全属性及钥匙串授权。') }
      } else { await this.metadata(id, await this.vault.stage(id, changes)) }
    })
  }
  async restoreCookies(id: string): Promise<void> {
    const saved = await this.vault.read(id)
    const upsert = saved.snapshot.filter((cookie) => !cookie.expires || cookie.expires === -1 || cookie.expires > Date.now() / 1000)
    await this.applyCookies(id, { upsert, remove: [] })
  }
  async stop(id: string): Promise<void> {
    const instance = this.entry(id)
    await instance.queue.run(() => this.stopInstance(instance))
  }
  private async closeBrowser(browser: Browser): Promise<void> {
    try { await withTimeout(browser.close(), 8000) } catch { browser.process()?.kill('SIGKILL') }
  }
  private async releaseCapture(instance: Instance): Promise<void> {
    const lease = instance.captureLease
    if (!lease) return
    await this.captureService?.release(lease)
    if (instance.captureLease === lease) instance.captureLease = undefined
  }
  captureUnavailable(ids: string[]) {
    for (const id of ids) {
      const instance = this.instances.get(id)
      if (instance) instance.runtime.warning = '抓包代理已退出，连接已关闭；请重启代理并重启该网站，不会自动改为直连'
    }
    this.changed()
  }
  async setCaptureEnabled(id: string, enabled: boolean) {
    await this.configurationQueue.run(async () => {
      this.store.site(id)
      await this.store.update((config) => { const site = config.sites.find((site) => site.id === id)!; site.captureEnabled = enabled; site.updatedAt = new Date().toISOString() })
      this.changed()
    })
  }
  private async stopInstance(instance: Instance): Promise<void> {
    if (!instance.browser) { await this.injections?.stop(instance.runtime.siteId); await this.releaseCapture(instance); instance.proxyCredentials = undefined; instance.runtime.status = 'stopped'; this.changed(); return }
    instance.runtime.status = 'stopping'; this.changed()
    await this.stopStream(instance)
    await Promise.all([...instance.pages.values()].map((tab) => tab.input.deactivate().catch(() => undefined)))
    try { await withTimeout(this.capture(instance), 5000) } catch { instance.runtime.warning = '退出前 Cookie 快照保存失败，浏览器目录仍会保留。' }
    const browser = instance.browser
    await Promise.all([...instance.pages.values()].map(async (tab) => { await tab.interception?.stop(); await tab.input.dispose() }))
    await this.injections?.stop(instance.runtime.siteId)
    await this.closeBrowser(browser)
    instance.browser = undefined; instance.pages.clear(); instance.proxyCredentials = undefined
    await this.releaseCapture(instance)
    instance.runtime.tabs = []; instance.runtime.activeTabId = undefined; instance.runtime.dialog = undefined
    instance.runtime.status = 'stopped'; instance.runtime.streamMode = 'paused'; this.changed()
    await this.configurationQueue.run(() => this.collectProxyCredentials())
  }
  async clearSite(id: string, remove: boolean): Promise<void> {
    const instance = this.entry(id)
    await instance.queue.run(async () => {
      await this.stopInstance(instance)
      await rm(this.store.profile(id), { recursive: true, force: true })
      await this.vault.clear(id)
      await this.store.update((config) => {
        if (remove) {
          config.sites = config.sites.filter((item) => item.id !== id)
        } else {
          const site = config.sites.find((item) => item.id === id)!
          delete site.cookieUpdatedAt; site.cookieCount = 0; site.pendingCookies = false
        }
      })
      this.instances.delete(id)
      await this.configurationQueue.run(() => this.collectProxyCredentials())
      this.changed()
    })
  }
  async shutdown(): Promise<void> {
    this.closing = true; clearInterval(this.timer)
    await Promise.all([...this.instances.values()].map((instance) => instance.queue.run(() => this.stopInstance(instance))))
  }
}
