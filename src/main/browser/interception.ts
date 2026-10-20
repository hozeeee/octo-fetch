import type { Protocol } from 'devtools-protocol'
import type { CDPSession, Page } from 'puppeteer-core'
import type { ProxyCredentials } from '../../shared/browser-options'
import type { Header, Hook, NetworkRequest, NetworkResponse, RequestPatch } from '../../shared/injections'
import type { InjectionSession } from '../scripts/injections'
import { INTERCEPT_TIMEOUT, matchesPattern, MAX_RESPONSE_BYTES, requestPatchSchema, responsePatchSchema } from '../../shared/injections'
import { urlSchema } from '../../shared/model'

export function matchesProxyChallenge(server: string, challenge: Protocol.Fetch.AuthChallenge): boolean {
  if (challenge.source !== 'Proxy') return false
  try { return new URL(server).origin === new URL(challenge.origin).origin } catch { return false }
}

export function bodyHeaders(headers: Header[], body: string): Header[] {
  return [...headers.filter((header) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(header.name.toLowerCase())), { name: 'Content-Length', value: String(Buffer.byteLength(body)) }]
}
export function responseSkipReason(request: NetworkRequest, status: number, headers: Header[]): string | undefined {
  const header = (name: string) => headers.find((header) => header.name.toLowerCase() === name)?.value || ''
  const contentType = header('content-type').toLowerCase()
  if (!['Fetch', 'XHR'].includes(request.resourceType)) return '仅处理 Fetch/XHR 响应正文'
  if (request.method === 'HEAD' || status < 200 || [204, 205, 304].includes(status) || (status >= 300 && status < 400)) return '无正文或重定向响应'
  if (contentType.includes('text/event-stream') || /ndjson|json-seq|multipart\//.test(contentType)) return '流式响应'
  if (!/^(?:application\/(?:[\w.-]+\+)?json|text\/)/.test(contentType)) return '非 JSON／文本响应'
  const charset = /charset\s*=\s*["']?([^;\s"']+)/.exec(contentType)?.[1]
  if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) return '非 UTF-8 文本'
  if (Number(header('content-length')) > MAX_RESPONSE_BYTES) return '响应正文超过 5 MiB'
}

export class PageInterception {
  private client?: CDPSession
  private closed = false
  private paused = new Set<string>()
  private notices = new Set<string>()
  private authAttempts = new Set<string>()
  private authRequests = new Map<string, Set<string>>()
  constructor(private page: Page, private tabId: string, private injection: InjectionSession | undefined, private warn: (text: string) => void, private proxy?: { server: string; credentials: ProxyCredentials }) {}
  async start() {
    this.client = await this.page.createCDPSession()
    this.client.on('Fetch.requestPaused', (event) => {
      if (this.closed || this.paused.has(event.requestId)) return
      this.paused.add(event.requestId)
      if (this.proxy && event.networkId) {
        const requests = this.authRequests.get(event.networkId) ?? new Set<string>()
        requests.add(event.requestId); this.authRequests.set(event.networkId, requests)
      }
      void this.handle(event).finally(() => this.paused.delete(event.requestId))
    })
    this.client.on('Fetch.authRequired', (event) => {
      void this.authenticate(event).catch(async () => {
        this.warn('代理认证失败，请检查代理地址和凭据')
        await this.client?.send('Fetch.continueWithAuth', { requestId: event.requestId, authChallengeResponse: { response: 'CancelAuth' } }).catch(() => undefined)
      })
    })
    if (this.proxy) {
      const finished = ({ requestId }: { requestId: string }) => {
        for (const id of this.authRequests.get(requestId) ?? []) this.authAttempts.delete(id)
        this.authRequests.delete(requestId)
      }
      this.client.on('Network.loadingFinished', finished)
      this.client.on('Network.loadingFailed', finished)
      await this.client.send('Network.enable')
    }
    await this.client.send('Fetch.enable', { handleAuthRequests: Boolean(this.proxy), patterns: [{ urlPattern: '*', requestStage: 'Request' }, ...(this.injection || this.proxy ? [{ urlPattern: '*', requestStage: 'Response' as const }] : [])] })
  }
  private async authenticate(event: Protocol.Fetch.AuthRequiredEvent) {
    if (this.closed || !this.client) return
    const matching = this.proxy && matchesProxyChallenge(this.proxy.server, event.authChallenge)
    const repeated = this.authAttempts.has(event.requestId)
    const response = matching && !repeated ? 'ProvideCredentials' : 'CancelAuth'
    if (matching && !repeated) this.authAttempts.add(event.requestId)
    if (matching && repeated) this.warn('代理认证被拒绝，请检查账号密码并重启网站')
    await this.client.send('Fetch.continueWithAuth', { requestId: event.requestId, authChallengeResponse: { response, ...(response === 'ProvideCredentials' ? this.proxy!.credentials : {}) } })
  }
  private hooks(stage: Hook['stage']) {
    const order = new Map(this.injection?.scripts.map((entry, index) => [entry.script.id, index]))
    return [...(this.injection?.hooks.values() || [])].filter((hook) => hook.tabId === this.tabId && hook.stage === stage).sort((a, b) => (order.get(a.scriptId) ?? 0) - (order.get(b.scriptId) ?? 0))
  }
  private notice(text: string) {
    if (this.notices.has(text)) return
    this.notices.add(text); this.injection?.notice(this.tabId, text)
  }
  private async invoke(hook: Hook, payload: NetworkRequest | { request: NetworkRequest; response: NetworkResponse }, deadline: number) {
    try {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('接口改写超过 10 秒预算')
      return await this.injection!.rpc({ type: 'invoke', hookId: hook.id, payload }, left)
    } catch (error) { this.injection!.disable(hook.scriptId, String(error)); throw error }
  }
  private async request(original: NetworkRequest, deadline: number): Promise<RequestPatch> {
    let request = structuredClone(original)
    let changed = false
    for (const hook of this.hooks('request')) {
      if (!this.injection!.hooks.has(hook.id) || !matchesPattern(hook.urlPattern, request.url)) continue
      try {
        const result = await this.invoke(hook, request, deadline)
        if (result == null) continue
        const patch = requestPatchSchema.parse(result)
        if (patch.postData !== undefined && Buffer.byteLength(patch.postData) > MAX_RESPONSE_BYTES) throw new Error('请求正文超过 5 MiB')
        if (patch.respond?.body !== undefined && Buffer.byteLength(patch.respond.body) > MAX_RESPONSE_BYTES) throw new Error('模拟响应正文超过 5 MiB')
        if (patch.abort || patch.respond) return patch
        request = { ...request, ...patch }; changed = true
      } catch (error) { this.injection!.disable(hook.scriptId, String(error)); return {} }
    }
    if (!changed) return {}
    const headers = request.postData !== original.postData ? request.headers.filter((header) => header.name.toLowerCase() !== 'content-length') : request.headers
    return { url: request.url, method: request.method, headers, postData: request.postData }
  }
  private async response(request: NetworkRequest, original: NetworkResponse, deadline: number): Promise<NetworkResponse | undefined> {
    let response = structuredClone(original), changed = false
    for (const hook of this.hooks('response')) {
      if (!this.injection!.hooks.has(hook.id) || !matchesPattern(hook.urlPattern, request.url)) continue
      try {
        const result = await this.invoke(hook, { request, response }, deadline)
        if (result == null) continue
        response = { ...response, ...responsePatchSchema.parse(result) }; changed = true
        if (Buffer.byteLength(response.body) > MAX_RESPONSE_BYTES) throw new Error('响应正文超过 5 MiB')
      } catch (error) { this.injection!.disable(hook.scriptId, String(error)); return }
    }
    return changed ? response : undefined
  }
  private async handle(event: Protocol.Fetch.RequestPausedEvent) {
    const client = this.client!
    const responseStage = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined
    if (responseStage && event.responseStatusCode !== 407) this.authAttempts.delete(event.requestId)
    const request: NetworkRequest = {
      url: event.request.url, method: event.request.method, headers: Object.entries(event.request.headers).map(([name, value]) => ({ name, value: String(value) })),
      postData: event.request.postData, resourceType: event.resourceType
    }
    // 完成决定只发送一次；发送失败不再重复 fulfill/continue，以免误处理新的请求。
    let settled = false
    const continueOriginal = async () => {
      if (settled || this.closed) return
      settled = true
      await client.send('Fetch.continueRequest', { requestId: event.requestId })
    }
    try {
      if (this.closed) return
      if (!responseStage && event.resourceType === 'Document' && request.url !== 'about:blank' && !urlSchema.safeParse(request.url).success) {
        settled = true; this.warn('已阻止不支持的导航协议')
        await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return
      }
      const deadline = Date.now() + INTERCEPT_TIMEOUT
      if (!responseStage) {
        const patch = await this.request(request, deadline)
        if (patch.abort) { settled = true; await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return }
        if (patch.respond) {
          const response = patch.respond, body = response.body || ''
          if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('模拟响应正文超过 5 MiB')
          settled = true
          await client.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: response.status, responseHeaders: bodyHeaders(response.headers || [], body), body: Buffer.from(body).toString('base64') }); return
        }
        settled = true
        await client.send('Fetch.continueRequest', { requestId: event.requestId, url: patch.url, method: patch.method, headers: patch.headers,
          postData: patch.postData === undefined ? undefined : Buffer.from(patch.postData).toString('base64') })
        return
      }
      if (event.responseErrorReason || !this.hooks('response').some((hook) => matchesPattern(hook.urlPattern, request.url))) { await continueOriginal(); return }
      const headers = event.responseHeaders || [], status = event.responseStatusCode!
      const reason = responseSkipReason(request, status, headers)
      if (reason) { this.notice(`跳过正文改写：${reason}`); await continueOriginal(); return }
      const data = await client.send('Fetch.getResponseBody', { requestId: event.requestId }, { timeout: Math.max(1, deadline - Date.now()) })
      const bytes = data.base64Encoded ? Buffer.from(data.body, 'base64') : Buffer.from(data.body)
      if (bytes.length > MAX_RESPONSE_BYTES) { this.notice('跳过正文改写：响应正文超过 5 MiB'); await continueOriginal(); return }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const response = await this.response(request, { status, headers, body }, deadline)
      if (!response) { await continueOriginal(); return }
      settled = true
      const noBody = [204, 205, 304].includes(response.status)
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId, responseCode: response.status, responseHeaders: bodyHeaders(response.headers, noBody ? '' : response.body),
        body: Buffer.from(noBody ? '' : response.body).toString('base64')
      })
    } catch (error) {
      if (!this.closed) this.notice(`接口处理失败，未提交的改写已放行原请求：${String(error).slice(0, 300)}`)
      await continueOriginal().catch(() => undefined)
    }
  }
  async stop() {
    if (this.closed) return
    this.closed = true
    await this.client?.send('Fetch.disable', undefined, { timeout: 2000 }).catch(() => undefined)
    await this.client?.detach().catch(() => undefined)
    this.client?.removeAllListeners()
    this.paused.clear(); this.authAttempts.clear(); this.authRequests.clear(); this.proxy = undefined
  }
}
