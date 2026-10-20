import type { IncomingMessage } from 'node:http'
import type { Server as Upstream } from 'proxy-chain'
import type { BrowserOptions, ProxyCredentials } from '../../shared/browser-options'
import type { CaptureBody, CaptureDetail, CapturePage, CaptureReady, CaptureRecord, CaptureSettings, CaptureSource } from '../../shared/capture'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { captureQuerySchema } from '../../shared/capture'
import { CaptureGateway } from './gateway'
import { assertCaptureDestination, createUpstream } from './upstream'

const require = createRequire(import.meta.url)
const reserved = (name: string) => /^(?:x-whistle-|x-octo-capture-)/i.test(name) || /^proxy-authorization$/i.test(name)
type Route = { source: CaptureSource; gateway: CaptureGateway; upstream: Upstream }
export class CaptureEngine {
  private proxy: any
  private server = createServer()
  private registry = new Map<number, CaptureSource>()
  private routes = new Map<string, Route>()
  private metadata = new Map<string, CaptureSource>()
  private blocked = new Set<number>()
  private external: CaptureSource = { id: 'external', name: '外部客户端' }
  private ready?: CaptureReady
  private certificate = ''
  private composeTokens = new Map<string, { source: CaptureSource; expires: number }>()
  private composerPorts = new Set<number>()
  private compose?: (req: any, res: any) => void
  constructor(private generation: string) {}
  async start(directory: string, settings: CaptureSettings, credentials?: ProxyCredentials): Promise<CaptureReady> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    process.env.WHISTLE_PATH = directory
    process.env.HOME = directory
    process.umask(0o077)
    const whistle = require('whistle')
    const config = require('whistle/lib/config')
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    const enginePort = (this.server.address() as { port: number }).port
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
    const uiPort = (reservation.address() as { port: number }).port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    this.blocked = new Set([settings.port, enginePort, uiPort])
    const username = 'octo', password = randomBytes(32).toString('hex')
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const options = {
      server: this.server, port: enginePort, host: '127.0.0.1', uiport: `127.0.0.1:${uiPort}`,
      username, password, storage: 'octo', baseDir: directory, noGlobalPlugins: true, disableAllPlugins: true,
      mode: `rulesOnly|captureData|safe|http2|disableUpdateTips|disableCustomCerts|${settings.https ? 'capture' : 'disableCapture'}`,
      reqCacheSize: 1000, frameCacheSize: 720,
      uiMiddleware: (req: any, res: any, next: any) => {
        if (req.headers.authorization !== authorization) { res.statusCode = 401; res.end('抓包工作台需要本次运行的鉴权'); return }
        if (/\/(?:plugins|certs|service|weinre)(?:\/|\?|$)|\/(?:create-cert|get-cert|rootca|set-sys-hosts|intercept-https-connects)(?:\?|$)/.test(req.url)) { res.statusCode = 403; res.end('请使用 Octo Fetch 配置与证书入口'); return }
        if (req.method === 'POST' && req.path === '/cgi-bin/composer') { void this.handleCompose(req, res); return }
        next()
      }
    }
    // 内部模块在首次加载时读取配置，必须先应用隔离目录及管理鉴权。
    config.extend(options)
    // 只托管固定版本的内置工作台服务；禁止 pfork 启动系统 Node 或插件。
    const serviceScript = require.resolve('whistle/lib/service/service')
    const serviceEvents = Object.assign(new EventEmitter(), { sendData: (data: any) => process.emit('data' as any, data), kill: () => undefined })
    ;(process as any).sendData = (data: any) => serviceEvents.emit('data', data)
    let service: Promise<any> | undefined
    require('pfork').fork = (settings: any, callback: any) => {
      if (settings.script !== serviceScript) { callback(new Error('抓包模块不允许启动第三方插件')); return }
      service ||= new Promise((resolve, reject) => {
        require(serviceScript)(settings, (error: Error | undefined, result: { port: number }) => {
          if (error) { reject(error); return }
          this.blocked.add(result.port); resolve(result)
        })
      })
      void service.then((result) => callback(null, result, serviceEvents), (error) => callback(error))
    }
    const rules = require('whistle/lib/rules')
    const Rules = require('whistle/lib/rules/rules')
    const util = require('whistle/lib/util')
    // 使用引擎自身传递的 clientPort 关联入口，跨 CONNECT 解密仍保留原始连接身份。
    // 解密后的 Upgrade 在引擎初始化请求前触发，身份取自引擎保存的隧道对象，不读取客户端 Header。
    const sourceOf = (req: any): CaptureSource | undefined => this.registry.get(Number(req.clientPort || req.socket?._remoteDataInfo?.clientPort || req.socket?.remotePort))
    const originalGetProxy = rules.getProxy
    rules.getProxy = (url: string, req: any, callback: (...args: any[]) => void) => {
      const source = sourceOf(req)
      if (!source) return callback(new Error('抓包来源已失效'))
      const route = this.routes.get(source.id)
      if (!route) return callback(new Error('抓包出口已关闭'))
      let target: URL
      try { target = new URL(url); assertCaptureDestination(target.hostname, Number(target.port || (/^(?:https|wss|tunnel):$/.test(target.protocol) ? 443 : 80)), this.blocked) } catch { return callback(new Error('禁止访问抓包内部服务')) }
      const manager = new Rules()
      manager.parse(`* proxy://127.0.0.1:${route.upstream.port}`)
      req.curUrl = url
      const proxyRule = manager.resolveProxy(req)
      if (!proxyRule) return callback(new Error('抓包路由解析失败'))
      // 允许 host 映射，但强制保持网站出口，禁止规则意外将流量改成直连。
      originalGetProxy(url, req, (error: unknown, ip: string, port: number) => {
        if (error) return callback(new Error('目标地址解析失败'))
        if (ip && req.rules?.host) req._phost = { hostname: ip, host: ip, port: port || target.port || (target.protocol === 'https:' ? 443 : 80) }
        req.rules = req.rules || {}; req.rules.proxy = proxyRule; delete req.rules.pac
        callback()
      })
    }
    const bizPath = require.resolve('whistle/biz')
    const originalBiz = require(bizPath)
    const blocked = this.blocked
    require.cache[bizPath]!.exports = function (this: any, req: any, res: any, next: any) {
      try {
        const url = new URL(util.getFullUrl(req))
        assertCaptureDestination(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80)), blocked)
        if (/whistle-path|_whistleInternalHost_|\/preview\.html\?/.test(req.url)) throw new Error('内部路径')
        if (!sourceOf(req)) throw new Error('来源失效')
        for (const key of Object.keys(req.headers)) {
          if (reserved(key)) delete req.headers[key]
        }
        return originalBiz.call(this, req, res, next)
      } catch { res.writeHead(403); res.end('抓包入口拒绝内部服务访问或失效来源') }
    }
    const sanitize = (req: IncomingMessage) => {
      const port = req.socket.remotePort!
      if (this.registry.has(port) && !this.composerPorts.has(port)) {
        for (const key of Object.keys(req.headers)) {
          if (reserved(key)) delete req.headers[key]
        }
        return
      }
      if (this.composerPorts.has(port)) this.registry.delete(port)
      const token = req.headers['x-octo-capture-auth']
      const context = typeof token === 'string' ? this.composeTokens.get(token) : undefined
      delete req.headers['x-octo-capture-auth']
      if (!context || context.expires < Date.now() || !this.routes.has(context.source.id)) return
      this.registry.set(port, context.source)
      if (!this.composerPorts.has(port)) req.socket.once('close', () => { this.registry.delete(port); this.composerPorts.delete(port) })
      this.composerPorts.add(port)
      req.headers[config.CLIENT_PORT_HEADER] = String(port)
      delete req.headers['proxy-authorization']
    }
    this.server.prependListener('request', sanitize)
    this.proxy = await new Promise<any>((resolve) => whistle(options, resolve))
    // CONNECT 的解密分支会先返回 200，且不经过 HTTP 中间件；必须在调用引擎监听器前拒绝。
    // EventEmitter 的 prependListener 不能阻止后续监听器，因此集中包装固定版本的隧道入口。
    for (const event of ['connect', 'upgrade'] as const) {
      const listeners = this.server.rawListeners(event)
      if (!listeners.length) throw new Error('Whistle 隧道入口契约已变化')
      this.server.removeAllListeners(event)
      this.server.on(event, (req, socket, head) => {
        try {
          sanitize(req)
          if (!sourceOf(req)) throw new Error('来源失效')
          if (event === 'connect' && !/^(?:\[[\da-f:.]+\]|[^:/?#@\\\s]+):\d+$/i.test(req.url || '')) throw new Error('CONNECT 地址无效')
          const url = new URL(event === 'connect' ? `https://${req.url}` : util.getFullUrl(req))
          assertCaptureDestination(url.hostname, Number(url.port || (/^(?:https|wss):$/.test(url.protocol) ? 443 : 80)), this.blocked)
        } catch {
          socket.on('error', () => socket.destroy())
          socket.setTimeout(1000, () => socket.destroy())
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        for (const listener of listeners) listener.call(this.server, req, socket, head)
      })
    }
    await new Promise<void>((resolve, reject) => require('whistle/lib/service')((error: Error | undefined) => error ? reject(error) : resolve()))
    this.compose = require('whistle/lib/service/composer').handleRequest
    const cgiUtil = require('whistle/biz/webui/cgi-bin/util')
    const getServerInfo = cgiUtil.getServerInfo
    // 引擎仍用 rulesOnly 禁用插件，工作台保留 Network、Rules 和 Composer。
    cgiUtil.getServerInfo = (...args: any[]) => ({ ...getServerInfo(...args), rulesOnlyMode: false, rulesMode: false })
    if (!config.rejectUnauthorized) throw new Error('Whistle 未启用上游证书校验')
    this.certificate = await readFile(this.proxy.httpsUtil.getRootCAFile(), 'utf8')
    const cert = new X509Certificate(this.certificate)
    await chmod(path.dirname(this.proxy.httpsUtil.getRootCAFile()), 0o700)
    await chmod(this.proxy.httpsUtil.getRootCAFile().replace(/\.crt$/, '.key'), 0o600)
    this.ready = { port: settings.port, uiPort, username, password, spki: createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'), fingerprint: cert.fingerprint256 }
    this.proxy.on('request', (_event: any, data: any) => {
      const source = this.registry.get(Number(data.req?.port))
      if (source) {
        this.metadata.set(data.id, source)
        // 原版工作台会在编辑／重放时保留 clientId，不污染原始请求头。
        data.clientId = `${this.generation}:${data.id}`
      }
      if (this.metadata.size > 4000) {
        for (const id of this.metadata.keys()) {
          if (!this.proxy.getItem(id)) this.metadata.delete(id)
        }
      }
    })
    await this.acquire(this.external, settings.upstream, credentials, settings.port, settings.lan, settings.allowedIps)
    return this.ready
  }
  private async handleCompose(req: any, res: any) {
    try {
      if (!this.compose) throw new Error('抓包服务尚未就绪')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 3 * 1048576) { res.status(413).end('Composer 请求过大'); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body || typeof body !== 'object' || typeof body.url !== 'string') throw new Error('Composer 参数无效')
      const common = require('whistle/lib/util/common')
      const headers = typeof body.headers === 'string'
        ? common.parseHeaders(body.headers)
        : common.lowerCaseify(body.headers || {})
      const reference = headers['x-whistle-client-id']
      let source = this.external
      if (reference) {
        if (typeof reference !== 'string' || !reference.startsWith(`${this.generation}:`)) throw new Error('重放来源已过期，请重新选择来源')
        const id = reference.slice(this.generation.length + 1)
        const original = this.metadata.get(id)
        if (!original || !this.proxy.getItem(id) || !this.routes.has(original.id)) throw new Error('原请求或网站出口已失效，请重新选择来源')
        source = original
      }
      if (!this.routes.has(source.id)) throw new Error('抓包出口已停止')
      for (const [token, context] of this.composeTokens) {
        if (context.expires < Date.now()) this.composeTokens.delete(token)
      }
      if (this.composeTokens.size >= 128) throw new Error('Composer 请求过多，请稍后重试')
      const token = randomBytes(32).toString('hex')
      this.composeTokens.set(token, { source, expires: Date.now() + 30000 })
      for (const key of Object.keys(headers)) {
        if (reserved(key)) delete headers[key]
      }
      headers['x-octo-capture-auth'] = token
      req.body = { ...body, headers, noStore: true }
      this.compose(req, res)
    } catch (error) {
      res.status(409).json({ ec: 2, em: error instanceof Error ? error.message : 'Composer 请求无效' })
    }
  }
  async acquire(source: CaptureSource, upstream?: BrowserOptions['proxy'], credentials?: ProxyCredentials, port = 0, lan = false, allowed?: string[]) {
    const relay = await createUpstream(upstream, credentials, this.blocked)
    const gateway = new CaptureGateway((this.server.address() as { port: number }).port, source, this.registry, allowed)
    try { await gateway.listen(port, lan) } catch (error) { await relay.close(true); throw error }
    this.blocked.add(gateway.port)
    this.routes.set(source.id, { source, gateway, upstream: relay })
    return { sourceId: source.id, port: gateway.port, spki: this.ready!.spki, fingerprint: this.ready!.fingerprint }
  }
  async release(id: string) {
    const route = this.routes.get(id)
    if (!route) return
    this.routes.delete(id)
    await route.gateway.close(); await route.upstream.close(true)
    // 已退休端口在本代运行中继续禁止，防止端口复用形成代理环路。
  }
  certificatePem() { return this.certificate }
  count() {
    for (const id of this.metadata.keys()) {
      if (!this.proxy?.getItem(id)) this.metadata.delete(id)
    }
    return this.metadata.size
  }
  private record(item: any): CaptureRecord {
    return { id: `${this.generation}:${item.id}`, source: this.metadata.get(item.id)!, url: item.url, method: item.req?.method || 'CONNECT', status: typeof item.res?.statusCode === 'number' ? item.res.statusCode : undefined, startedAt: item.startTime, endedAt: item.endTime, error: item.reqError || item.resError ? '请求或响应失败' : undefined }
  }
  query(raw: unknown): CapturePage {
    const query = captureQuerySchema.parse(raw)
    if (query.cursor && !query.cursor.startsWith(`${this.generation}:`)) throw new Error('抓包游标已过期')
    const start = query.cursor?.slice(this.generation.length + 1)
    if (query.cursor !== undefined && (!start || !this.metadata.has(start) || !this.proxy.getItem(start))) throw new Error('抓包游标无效、已淘汰或已清空')
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error('抓包时间范围无效')
    const records = [...this.metadata.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).filter((id) => !start || id.localeCompare(start, undefined, { numeric: true }) > 0).flatMap((id) => {
      const item = this.proxy.getItem(id)
      if (!item) { this.metadata.delete(id); return [] }
      const record = this.record(item)
      return (query.siteId && record.source.siteId !== query.siteId) || (query.external && record.source.siteId) || (query.url && !record.url.toLowerCase().includes(query.url.toLowerCase())) || (query.method && record.method !== query.method.toUpperCase()) || (query.status && record.status !== query.status) || (query.from !== undefined && record.startedAt < query.from) || (query.to !== undefined && record.startedAt > query.to) ? [] : [record]
    })
    const items = records.slice(0, query.limit)
    return { items, generation: this.generation, cursor: items.at(-1)?.id }
  }
  detail(id: string, siteId?: string): CaptureDetail {
    if (!id.startsWith(`${this.generation}:`)) throw new Error('抓包记录已过期')
    const key = id.slice(this.generation.length + 1), source = this.metadata.get(key)
    const item = this.proxy.getItem(key)
    if (!item || !source || (siteId && source.siteId !== siteId)) throw new Error('抓包记录不存在、已淘汰或无权访问')
    const part = (data: any, complete: boolean) => ({ headers: Object.entries(data?.headers || {}).filter(([name]) => !reserved(name)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((entry) => ({ name, value: String(entry) }))), body: this.body(data, complete) })
    return { ...this.record(item), request: part(item.req, Boolean(item.requestTime)), response: part(item.res, Boolean(item.endTime)) }
  }
  private body(data: any, complete: boolean): CaptureBody {
    const bytes = typeof data?.base64 === 'string' ? Buffer.from(data.base64, 'base64') : Buffer.isBuffer(data?.body) ? data.body as Buffer : Buffer.alloc(0)
    const wireSize = typeof data?.size === 'number' ? data.size : bytes.length
    const contentType = String(data?.headers?.['content-type'] || '')
    const contentEncoding = String(data?.headers?.['content-encoding'] || '').trim().toLowerCase() || undefined
    const compressed = Boolean(contentEncoding && contentEncoding !== 'identity')
    const decoded = !compressed || (/^(?:gzip|deflate|br)$/.test(contentEncoding!) && !data?.hasGzipError)
    // Whistle 缓存的是解压后的 Buffer/base64；解压错误可能被写成错误栈字符串。
    const failed = typeof data?.body === 'string' && data.body.length > 0 && typeof data?.base64 !== 'string'
    const size = decoded && typeof data?.unzipSize === 'number' && data.unzipSize >= 0 ? data.unzipSize : Math.max(wireSize, bytes.length)
    const unavailable = failed || (!bytes.length && ((wireSize > 0 && !(decoded && data?.unzipSize === 0)) || !complete || !data))
    const truncated = !complete || failed || bytes.length > 1048576 || (decoded && compressed ? unavailable : wireSize > bytes.length)
    const encoding = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]?.toLowerCase() || 'utf-8'
    const result: CaptureBody = { size, wireSize, encoding, contentEncoding, decoded, pending: !complete, truncated, unavailable }
    if (unavailable) return result
    const body = bytes.subarray(0, 1048576)
    if (decoded && /json|text|xml|javascript|urlencoded/i.test(contentType)) {
      try { result.text = new TextDecoder(encoding, { fatal: true }).decode(body, { stream: truncated }); return result } catch { /* 不支持的字符集或无效文本保留原始字节。 */ }
    }
    result.base64 = body.toString('base64')
    return result
  }
  async stop() {
    await Promise.all([...this.routes.keys()].map((id) => this.release(id)))
    this.server.closeAllConnections(); this.server.close()
  }
}
